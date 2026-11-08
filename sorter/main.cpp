// main.cpp — 传送带快递自动分拣 C++ 主程序
// 3fps 采集 → 纸箱检测 → engine.tick；OCR/LLM/舵机由后端异步执行并回调 engine。
// 日志格式与 Python 版一致：`[HH:MM:SS] msg`，console + 文件。
#include "hw.hpp"
#include "llm_client.hpp"
#include "ocr_client.hpp"

#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <opencv2/highgui.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <sys/stat.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

std::atomic<bool> g_stop{false};

void on_signal(int) {
    g_stop.store(true);
}

struct CpuTimes {
    unsigned long long total = 0;
    unsigned long long idle = 0;
};

CpuTimes read_cpu_times() {
    CpuTimes t;
    std::ifstream in("/proc/stat");
    std::string line;
    if (!std::getline(in, line)) return t;
    std::istringstream ss(line);
    std::string cpu;
    unsigned long long v[8] = {0};
    ss >> cpu;
    for (int i = 0; i < 8; ++i) ss >> v[i];
    t.idle = v[3] + v[4];   // idle + iowait
    for (int i = 0; i < 8; ++i) t.total += v[i];
    return t;
}

double cpu_busy_ratio(const CpuTimes& a, const CpuTimes& b) {
    const unsigned long long dt = b.total - a.total;
    const unsigned long long di = b.idle - a.idle;
    if (dt == 0) return 0.0;
    return 1.0 - static_cast<double>(di) / static_cast<double>(dt);
}

// 传送带守护进程：常驻运行 belt_ctl.py daemon，通过 stdin 发 on/off 命令。
// 关键点：GPIO 电平由该常驻进程持有，进程退出即复位，所以必须全程存活。
class MotorDaemon {
public:
    using LogFn = std::function<void(const std::string&)>;

    explicit MotorDaemon(const std::string& cmd, LogFn log) : log_(std::move(log)) {
        int inp[2];
        if (pipe(inp) != 0) {
            if (log_) log_("传送带守护进程：pipe 创建失败");
            return;
        }
        const pid_t pid = fork();
        if (pid < 0) {
            close(inp[0]);
            close(inp[1]);
            if (log_) log_("传送带守护进程：fork 失败");
            return;
        }
        if (pid == 0) {
            dup2(inp[0], STDIN_FILENO);
            const int devnull = open("/dev/null", O_WRONLY);
            if (devnull >= 0) {
                dup2(devnull, STDOUT_FILENO);
            }
            close(inp[0]);
            close(inp[1]);
            execl("/bin/sh", "sh", "-c", cmd.c_str(), static_cast<char*>(nullptr));
            _exit(127);
        }
        close(inp[0]);
        in_ = inp[1];
        pid_ = pid;
    }

    MotorDaemon(const MotorDaemon&) = delete;
    MotorDaemon& operator=(const MotorDaemon&) = delete;

    bool alive() const { return in_ >= 0 && pid_ > 0; }

    void set(bool on) {
        if (in_ < 0) {
            return;
        }
        const char* s = on ? "on\n" : "off\n";
        if (write(in_, s, std::strlen(s)) < 0) {
            if (log_) log_("传送带守护进程写入失败");
        }
    }

    ~MotorDaemon() {
        if (in_ >= 0) {
            const char* s = "off\n";
            ssize_t r = write(in_, s, std::strlen(s));
            (void)r;
            close(in_);
            in_ = -1;
        }
        if (pid_ > 0) {
            int st = 0;
            waitpid(pid_, &st, 0);
            pid_ = -1;
        }
    }

private:
    int in_ = -1;
    pid_t pid_ = -1;
    LogFn log_;
};

// Python build_logger 的同文件检测：日志文件若是 stdout 重定向目标则不重复写
bool same_file_as_stdout(const std::string& path) {
    struct stat a {};
    struct stat b {};
    if (::fstat(STDOUT_FILENO, &a) != 0) {
        return false;
    }
    if (::stat(path.c_str(), &b) != 0) {
        return false;
    }
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}

class Logger {
public:
    explicit Logger(const std::string& path) {
        if (path.empty()) {
            return;
        }
        path_ = path;
        if (same_file_as_stdout(path)) {
            same_ = true;
            return;
        }
        file_ = std::fopen(path.c_str(), "a");
        if (!file_) {
            // 配置目录未建时回退到 /tmp（任务允许）
            fallback_ = "/tmp/sorter_cpp.log";
            file_ = std::fopen(fallback_.c_str(), "a");
        }
    }

    ~Logger() {
        if (file_) {
            std::fclose(file_);
        }
    }

    Logger(const Logger&) = delete;
    Logger& operator=(const Logger&) = delete;

    void log(const std::string& msg) {
        std::lock_guard<std::mutex> lk(mu_);
        char ts[16];
        std::time_t t = std::time(nullptr);
        std::tm tmv {};
        ::localtime_r(&t, &tmv);
        std::strftime(ts, sizeof(ts), "%H:%M:%S", &tmv);
        std::string line = std::string("[") + ts + "] " + msg;
        std::fputs(line.c_str(), stdout);
        std::fputc('\n', stdout);
        std::fflush(stdout);
        if (file_) {
            std::fputs(line.c_str(), file_);
            std::fputc('\n', file_);
            std::fflush(file_);
        }
    }

    bool used_fallback() const { return !fallback_.empty() && file_ != nullptr; }
    const std::string& requested_path() const { return path_; }
    const std::string& fallback_path() const { return fallback_; }

private:
    std::mutex mu_;
    FILE* file_ = nullptr;
    std::string path_;
    std::string fallback_;
    bool same_ = false;
};

struct Args {
    std::string config;
    int tape_x = -1;
    bool snapshot = false;
    std::string snapshot_path = "/tmp/sorter_cpp_snapshot.jpg";
    std::string ocr_test;
    std::string classify_test;
    bool dry_run = false;
    bool no_servo = false;
    std::string fake_province = "新疆维吾尔自治区";
    std::string fake_category = "货运";
    double duration = 0.0;
    bool display = false;   // 实时显示窗口（默认有图形环境时开启）
};

std::string exe_dir() {
    char buf[4096];
    ssize_t n = ::readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    if (n <= 0) {
        return ".";
    }
    buf[n] = '\0';
    std::string p(buf);
    auto pos = p.find_last_of('/');
    if (pos == std::string::npos) {
        return ".";
    }
    return p.substr(0, pos);
}

void print_usage(const char* argv0) {
    std::printf(
        "用法: %s [选项]\n"
        "  --config <path>          配置文件（默认同目录 sorter_cpp.json）\n"
        "  --tape-x N               覆盖触发线 x 像素\n"
        "  --snapshot [--snapshot-path p]  抓一帧画检测框/ROI/触发线后退出\n"
        "  --ocr-test <图片>        单独测试百度手写 OCR 并退出\n"
        "  --classify-test <省份>   单独测试 LLM 分类并退出\n"
        "  --dry-run                假 OCR/LLM/舵机（跟踪与触发时序验证）\n"
        "  --no-servo               真实 OCR/LLM，但不动作物理舵机\n"
        "  --fake-province <名>     dry-run 假省份（默认 新疆维吾尔自治区）\n"
        "  --fake-category {省内,货运,空运}\n"
        "  --display                在开发板屏幕上显示实时画面（有 DISPLAY/WAYLAND_DISPLAY 时默认开启）\n"
        "  --no-display             不打开显示窗口\n"
        "  --duration N             运行秒数，0=常驻\n",
        argv0);
}

bool parse_args(int argc, char** argv, Args& a) {
    a.config = exe_dir() + "/sorter_cpp.json";
    a.display = (std::getenv("DISPLAY") != nullptr || std::getenv("WAYLAND_DISPLAY") != nullptr);
    for (int i = 1; i < argc; ++i) {
        const std::string k = argv[i];
        auto next = [&](const char* name, std::string& out) -> bool {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "参数 %s 缺少值\n", name);
                return false;
            }
            out = argv[++i];
            return true;
        };
        std::string v;
        if (k == "--config") {
            if (!next("--config", a.config)) return false;
        } else if (k == "--tape-x") {
            if (!next("--tape-x", v)) return false;
            a.tape_x = std::atoi(v.c_str());
        } else if (k == "--snapshot") {
            a.snapshot = true;
        } else if (k == "--snapshot-path") {
            if (!next("--snapshot-path", a.snapshot_path)) return false;
        } else if (k == "--ocr-test") {
            if (!next("--ocr-test", a.ocr_test)) return false;
        } else if (k == "--classify-test") {
            if (!next("--classify-test", a.classify_test)) return false;
        } else if (k == "--dry-run") {
            a.dry_run = true;
        } else if (k == "--no-servo") {
            a.no_servo = true;
        } else if (k == "--fake-province") {
            if (!next("--fake-province", a.fake_province)) return false;
        } else if (k == "--fake-category") {
            if (!next("--fake-category", a.fake_category)) return false;
        } else if (k == "--duration") {
            if (!next("--duration", v)) return false;
            a.duration = std::atof(v.c_str());
        } else if (k == "--display") {
            a.display = true;
        } else if (k == "--no-display") {
            a.display = false;
        } else if (k == "-h" || k == "--help") {
            print_usage(argv[0]);
            std::exit(0);
        } else {
            std::fprintf(stderr, "未知参数: %s\n", k.c_str());
            print_usage(argv[0]);
            return false;
        }
    }
    if (a.fake_category != "省内" && a.fake_category != "货运" && a.fake_category != "空运") {
        std::fprintf(stderr, "--fake-category 必须是 省内/货运/空运\n");
        return false;
    }
    return true;
}

// 与 Python 日志中 `{fps}fps` 显示一致（3.0fps）
std::string fps_str(double fps) {
    char buf[32];
    if (fps == static_cast<double>(static_cast<long long>(fps))) {
        std::snprintf(buf, sizeof(buf), "%.1f", fps);
    } else {
        std::snprintf(buf, sizeof(buf), "%g", fps);
    }
    return buf;
}

double steady_sec() {
    return std::chrono::duration<double>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

}  // namespace

int main(int argc, char** argv) {
    std::signal(SIGPIPE, SIG_IGN);   // 本地 OCR 子进程重启时避免写管道崩溃
    Args args;
    if (!parse_args(argc, argv, args)) {
        return 2;
    }

    AppConfig cfg;
    try {
        cfg = load_config(args.config);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "加载配置失败: %s\n", e.what());
        return 1;
    }

    Logger logger(cfg.log_file);
    auto log = [&logger](const std::string& msg) { logger.log(msg); };
    if (logger.used_fallback()) {
        log("日志文件 " + logger.requested_path() + " 打开失败，改用 " + logger.fallback_path());
    }

    {
        std::string tuning_path = args.config;
        const size_t slash = tuning_path.find_last_of('/');
        tuning_path = (slash == std::string::npos ? std::string(".") : tuning_path.substr(0, slash)) +
                      "/tuning.yaml";
        if (hw::load_tuning_file(cfg, tuning_path, log)) {
            // 已加载并打印摘要
        }
    }
    if (args.tape_x >= 0) {
        cfg.sorter.tape_x = args.tape_x;
        log("命令行覆盖 tape_x=" + std::to_string(cfg.sorter.tape_x));
    }

    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    curl_global_init(CURL_GLOBAL_DEFAULT);

    // ---- 单独测试：百度手写 OCR ----
    if (!args.ocr_test.empty()) {
        try {
            OcrClient ocr(cfg.ocr);
            std::string text = ocr.recognize(args.ocr_test);
            std::string province = hw::parse_province(text);
            std::printf("OCR text: %s\n", text.c_str());
            std::printf("province: %s\n", province.empty() ? "None" : province.c_str());
            curl_global_cleanup();
            return 0;
        } catch (const std::exception& e) {
            std::fprintf(stderr, "OCR 失败: %s\n", e.what());
            curl_global_cleanup();
            return 1;
        }
    }

    // ---- 单独测试：LLM 分类 ----
    if (!args.classify_test.empty()) {
        LlmClient llm(cfg.llm);
        LlmResult r = llm.ask(args.classify_test);
        nlohmann::json out;
        out["input"] = {{"province", args.classify_test}};
        out["ok"] = r.ok;
        if (r.ok) {
            out["shipping"] = r.shipping;
        } else {
            out["error"] = r.error;
        }
        if (!r.raw.empty()) {
            out["raw"] = r.raw;
        }
        out["elapsed_ms"] = static_cast<int>(r.ms);
        std::printf("%s\n", out.dump(2).c_str());
        curl_global_cleanup();
        return r.ok ? 0 : 2;
    }

    cv::VideoCapture cap = hw::open_camera(cfg.camera);
    if (!cap.isOpened()) {
        log("摄像头打开失败（检查是否被网页/其他程序占用）");
        curl_global_cleanup();
        return 1;
    }

    // ---- 抓拍 ----
    if (args.snapshot) {
        cv::Mat frame;
        bool ok = cap.read(frame) && !frame.empty();
        cap.release();
        if (!ok) {
            log("抓拍失败");
            curl_global_cleanup();
            return 1;
        }
        std::vector<cv::Rect> boxes = hw::detect_boxes(frame, cfg.detection);
        cv::Mat vis = frame.clone();
        for (const auto& b : boxes) {
            cv::rectangle(vis, cv::Point(b.x, b.y), cv::Point(b.x + b.width, b.y + b.height),
                          cv::Scalar(0, 255, 0), 2);
        }
        const int roi_top = cfg.detection.roi_top;
        cv::line(vis, cv::Point(0, roi_top), cv::Point(vis.cols - 1, roi_top),
                 cv::Scalar(255, 0, 0), 1);
        const int tx = cfg.sorter.tape_x;
        cv::line(vis, cv::Point(tx, 0), cv::Point(tx, vis.rows - 1), cv::Scalar(0, 0, 255), 2);
        cv::putText(vis, "TAPE_X=" + std::to_string(tx), cv::Point(std::max(8, tx - 100), 32),
                    cv::FONT_HERSHEY_SIMPLEX, 0.9, cv::Scalar(0, 0, 255), 2);
        cv::imwrite(args.snapshot_path, vis);
        log("snapshot: " + args.snapshot_path + ", detections=" + std::to_string(boxes.size()));
        for (const auto& b : boxes) {
            log("  box x=" + std::to_string(b.x) + " y=" + std::to_string(b.y) +
                " w=" + std::to_string(b.width) + " h=" + std::to_string(b.height));
        }
        curl_global_cleanup();
        return 0;
    }

    // ---- 运行（真实后端或干跑）----
    std::unique_ptr<Engine> engine;
    std::unique_ptr<Backends> backends;
    std::unique_ptr<MotorDaemon> motor;
    bool real_backends = false;
    try {
        engine = std::make_unique<Engine>(cfg.sorter, log);
        if (args.dry_run) {
            backends = std::make_unique<FakeBackends>(engine.get(), log, args.fake_category,
                                                      args.fake_province);
        } else {
            auto rb = std::make_unique<RealBackends>(cfg, engine.get(), log, args.no_servo);
            rb->setEngine(engine.get());
            backends = std::move(rb);
            real_backends = true;
        }
        engine->setBackends(backends.get());

        // 分拣完成记录：写入 /root/sorter/Record/<日期>_<时间>_P<pid>.json
        const std::string record_dir = "/root/sorter/Record";
        {
            std::error_code ec;
            std::filesystem::create_directories(record_dir, ec);
            if (ec) {
                log("记录目录创建失败: " + record_dir + " (" + ec.message() + ")");
            }
        }
        engine->setRecordCallback([record_dir, &log](const Engine::SortRecord& r) {
            try {
                const std::time_t tt = std::time(nullptr);
                std::tm tm{};
                localtime_r(&tt, &tm);
                char day[16] = {0};
                char hms[16] = {0};
                char human[32] = {0};
                std::strftime(day, sizeof(day), "%Y%m%d", &tm);
                std::strftime(hms, sizeof(hms), "%H%M%S", &tm);
                std::strftime(human, sizeof(human), "%Y-%m-%d %H:%M:%S", &tm);
                nlohmann::json j;
                j["pid"] = r.pid;
                j["time"] = human;
                j["timestamp"] = static_cast<long long>(tt);
                j["province"] = r.province;
                j["category"] = r.category;
                j["servo"] = r.servo;
                j["result"] = r.result;
                j["ocr_calls"] = r.ocr_calls;
                const std::string name =
                    std::string(day) + "_" + hms + "_P" + std::to_string(r.pid) + ".json";
                const std::string path = record_dir + "/" + name;
                const std::string tmp = path + ".tmp";
                {
                    std::ofstream out(tmp, std::ios::binary);
                    out << j.dump(2) << "\n";
                }
                std::error_code ec;
                std::filesystem::rename(tmp, path, ec);
                if (ec) {
                    log("快递记录写入失败: " + path + " (" + ec.message() + ")");
                }
            } catch (const std::exception& e) {
                log(std::string("快递记录异常: ") + e.what());
            }
        });
        if (!args.dry_run && !cfg.motor_cmd.empty()) {
            const std::string tmpl = cfg.motor_cmd;
            if (tmpl.find("{state}") != std::string::npos) {
                // 兼容旧的一次性命令模式
                engine->setBeltControl([tmpl, log](bool on) {
                    std::string cmd = tmpl;
                    const std::string state = on ? "on" : "off";
                    size_t pos = 0;
                    while ((pos = cmd.find("{state}", pos)) != std::string::npos) {
                        cmd.replace(pos, 7, state);
                        pos += state.size();
                    }
                    const int rc = std::system((cmd + " >/dev/null 2>&1").c_str());
                    if (rc != 0) {
                        log("传送带控制命令失败 rc=" + std::to_string(rc));
                    }
                });
            } else {
                // 常驻守护进程模式：引脚电平由 Python 进程持续保持
                motor = std::make_unique<MotorDaemon>(tmpl, log);
                MotorDaemon* m = motor.get();
                engine->setBeltControl([m](bool on) { m->set(on); });
            }
            log("传送带电机控制已启用：" + tmpl);
        } else if (!args.dry_run) {
            log("传送带电机控制未启用（motor_cmd 为空）");
        }
    } catch (const std::exception& e) {
        log(std::string("初始化失败: ") + e.what());
        cap.release();
        curl_global_cleanup();
        return 1;
    }

    // 启动手势：两只舵机同时摆动一次，作为“系统开始运作”的物理指示
    if (real_backends && !args.no_servo) {
        std::string cmd = cfg.servo_cmd;
        size_t pos = 0;
        while ((pos = cmd.find("{id}", pos)) != std::string::npos) {
            cmd.replace(pos, 4, "1,2");
            pos += 3;
        }
        log("启动手势：两只舵机同时摆动（表示系统开始运作）");
        int rc = std::system(cmd.c_str());
        log(rc == 0 ? "启动手势完成，进入分拣循环"
                    : ("启动手势失败 rc=" + std::to_string(rc)));
    }

    const std::string display_window = "Sorter";
    bool display_ok = false;
    const int display_w = std::clamp(cfg.sorter.display_width, 160, cfg.sorter.cam_w);
    const int display_h = std::clamp(cfg.sorter.display_height, 90, cfg.sorter.cam_h);
    const double display_interval = 1.0 / std::clamp(cfg.sorter.display_fps, 0.5, 30.0);
    double last_display = -1e9;
    if (args.display) {
        try {
            cv::namedWindow(display_window, cv::WINDOW_NORMAL);
            cv::resizeWindow(display_window, display_w, display_h);
            display_ok = true;
            log("实时显示已开启（" + std::to_string(display_w) + "x" + std::to_string(display_h) +
                "，裁剪 x=" + std::to_string(cfg.sorter.display_crop_x) + " y=" +
                std::to_string(cfg.sorter.display_crop_y) + " w=" +
                std::to_string(cfg.sorter.display_crop_w) + " h=" +
                std::to_string(cfg.sorter.display_crop_h) + "，显示上限 " +
                fps_str(cfg.sorter.display_fps) + "fps" +
                (cfg.sorter.display_flip ? "，左右翻转" : "") +
                "；按 q 或关闭窗口可停用）");
        } catch (const std::exception& e) {
            log(std::string("显示窗口创建失败：") + e.what());
        }
    }

    double target_fps = std::clamp(cfg.camera.fps, 0.5, 30.0);
    double loop_interval = 1.0 / target_fps;
    CpuTimes prev_cpu = read_cpu_times();
    double last_cpu_check = steady_sec();
    bool prev_classify_busy = false;
    const double started = steady_sec();
    log("启动：方向=" + cfg.sorter.direction + " 触发线x=" + std::to_string(cfg.sorter.tape_x) +
        " 处理帧率 " + fps_str(cfg.camera.fps_low) + "~" + fps_str(cfg.camera.fps_high) +
        "fps（基准 " + fps_str(cfg.camera.fps) + "） dry_run=" +
        (args.dry_run ? "True" : "False"));

    while (!g_stop.load()) {
        const auto iter_start = std::chrono::steady_clock::now();
        cv::Mat frame;
        const bool ok = cap.isOpened() && cap.read(frame) && !frame.empty();
        const double now = steady_sec();
        if (!ok) {
            engine->camera_lost(now);
            log("读帧失败，尝试重连摄像头");
            cap.release();
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            cap = hw::open_camera(cfg.camera);
            continue;
        }
        try {
            std::vector<cv::Rect> boxes = hw::detect_boxes(frame, cfg.detection);
            engine->tick(boxes, frame, now);
        } catch (const std::exception& e) {
            log(std::string("处理帧异常: ") + e.what());
        }

        bool busy_now = false;
        if (real_backends) {
            busy_now = static_cast<RealBackends*>(backends.get())->ocr_llm_jobs() > 0;
        }
        double new_fps = target_fps;
        if (busy_now) {
            new_fps = cfg.camera.fps_low;
        } else if (prev_classify_busy) {
            new_fps = cfg.camera.fps_high;
        } else if (now - last_cpu_check >= std::max(0.2, cfg.camera.fps_check_sec)) {
            const CpuTimes cur = read_cpu_times();
            const double ratio = cpu_busy_ratio(prev_cpu, cur);
            prev_cpu = cur;
            last_cpu_check = now;
            if (target_fps >= cfg.camera.fps_high - 0.01) {
                if (ratio > cfg.camera.cpu_high_ratio) new_fps = cfg.camera.fps;
            } else if (ratio < cfg.camera.cpu_high_ratio * 0.8) {
                new_fps = cfg.camera.fps_high;
            }
        }
        const double next_fps = std::clamp(new_fps, 0.5, 30.0);
        if (std::fabs(next_fps - target_fps) > 0.01) {
            target_fps = next_fps;
            loop_interval = 1.0 / target_fps;
        }
        prev_classify_busy = busy_now;

        if (display_ok && now - last_display >= display_interval) {
            last_display = now;
            try {
                cv::Rect crop(cfg.sorter.display_crop_x, cfg.sorter.display_crop_y,
                              cfg.sorter.display_crop_w, cfg.sorter.display_crop_h);
                crop &= cv::Rect(0, 0, frame.cols, frame.rows);
                if (crop.width < 10 || crop.height < 10) {
                    crop = cv::Rect(0, 0, frame.cols, frame.rows);
                }
                cv::Mat vis;
                cv::resize(frame(crop), vis, cv::Size(display_w, display_h), 0, 0,
                           cv::INTER_LINEAR);
                if (cfg.sorter.display_flip) {
                    cv::flip(vis, vis, 1);   // 只翻转显示，不影响检测/OCR 坐标
                }
                const double sx = static_cast<double>(display_w) / crop.width;
                const double sy = static_cast<double>(display_h) / crop.height;
                const double font_scale = 0.55;
                for (const auto& tv : engine->track_views()) {
                    if (tv.w <= 0 || tv.h <= 0) continue;
                    const int x0 = static_cast<int>(std::lround((tv.x - crop.x) * sx));
                    const int y = static_cast<int>(std::lround((tv.y - crop.y) * sy));
                    const int w = static_cast<int>(std::lround(tv.w * sx));
                    const int h = static_cast<int>(std::lround(tv.h * sy));
                    const int x = cfg.sorter.display_flip ? (display_w - (x0 + w)) : x0;
                    if (x + w < 0 || y + h < 0 || x >= display_w || y >= display_h) continue;
                    cv::rectangle(vis, cv::Rect(x, y, w, h), cv::Scalar(0, 0, 255),
                                  tv.active ? 2 : 1);
                    const std::string tag = "P" + std::to_string(tv.pid);
                    int baseline = 0;
                    const cv::Size ts = cv::getTextSize(tag, cv::FONT_HERSHEY_SIMPLEX,
                                                       font_scale, 2, &baseline);
                    int tx = std::max(0, x + 2);
                    int ty = std::max(ts.height + 3, y + ts.height + 5);
                    if (tx + ts.width + 6 > vis.cols) {
                        tx = std::max(0, vis.cols - ts.width - 8);
                    }
                    if (ty - ts.height - 3 < 0) ty = ts.height + 3;
                    cv::rectangle(vis,
                                  cv::Rect(tx, ty - ts.height - 3, ts.width + 6, ts.height + 6),
                                  cv::Scalar(255, 255, 255), cv::FILLED);
                    cv::putText(vis, tag, cv::Point(tx + 3, ty - 1),
                                cv::FONT_HERSHEY_SIMPLEX, font_scale, cv::Scalar(0, 0, 255),
                                2, cv::LINE_AA);
                }
                cv::imshow(display_window, vis);
                const int key = cv::waitKey(1);
                const double visible =
                    cv::getWindowProperty(display_window, cv::WND_PROP_VISIBLE);
                if (key == 'q' || key == 27 || visible == 0) {
                    log("显示窗口已关闭，继续无界面运行");
                    display_ok = false;
                    cv::destroyWindow(display_window);
                }
            } catch (const std::exception& e) {
                log(std::string("显示异常，停止显示：") + e.what());
                display_ok = false;
            }
        }
        if (args.duration > 0 && (steady_sec() - started) > args.duration) {
            break;
        }
        const double elapsed =
            std::chrono::duration<double>(std::chrono::steady_clock::now() - iter_start).count();
        if (elapsed < loop_interval) {
            std::this_thread::sleep_for(std::chrono::duration<double>(loop_interval - elapsed));
        }
    }

    const bool interrupted = g_stop.load();
    cap.release();
    if (interrupted) {
        log("手动停止");
    }

    // 后台 OCR/LLM 任务收尾：短暂等待，仍有未完成则强制退出
    // （等价 Python daemon 线程语义，避免析构时仍有工作者回调 engine）
    if (real_backends) {
        auto* rb = static_cast<RealBackends*>(backends.get());
        if (rb->active_jobs() > 0) {
            log("等待后台任务结束...");
            rb->wait_idle(3000);
        }
        if (rb->active_jobs() > 0) {
            log("仍有后台任务（OCR/LLM）未完成，强制退出");
            std::fflush(stdout);
            std::fflush(stderr);
            _Exit(0);
        }
    }

    backends.reset();
    engine.reset();
    if (motor) {
        motor.reset();   // 析构：发送 off 并等待守护进程退出（引脚复位）
        log("传送带守护进程已退出（引脚已复位）");
    }
    if (args.display) {
        cv::destroyAllWindows();
    }
    curl_global_cleanup();
    return 0;
}
