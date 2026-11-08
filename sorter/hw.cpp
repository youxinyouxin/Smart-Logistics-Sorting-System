// hw.cpp — 配置加载、摄像头、纸箱检测、省份解析、真实/假后端
#include "hw.hpp"

#include <fcntl.h>
#include <spawn.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <nlohmann/json.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <thread>

extern char** environ;

namespace {

using json = nlohmann::json;

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

const json& get_section(const json& j, const char* key) {
    static const json kEmpty = json::object();
    if (!j.is_object()) {
        return kEmpty;
    }
    auto it = j.find(key);
    if (it == j.end() || !it->is_object()) {
        return kEmpty;
    }
    return *it;
}

template <typename T>
T getv(const json& j, const char* key, const T& def) {
    if (!j.is_object()) {
        return def;
    }
    auto it = j.find(key);
    if (it == j.end() || it->is_null()) {
        return def;
    }
    try {
        return it->get<T>();
    } catch (const std::exception&) {
        return def;
    }
}

cv::Scalar get_hsv(const json& j, const char* key, const cv::Scalar& def) {
    auto it = j.find(key);
    if (it == j.end() || !it->is_array() || it->size() < 3) {
        return def;
    }
    try {
        return cv::Scalar((*it)[0].get<double>(), (*it)[1].get<double>(), (*it)[2].get<double>());
    } catch (const std::exception&) {
        return def;
    }
}

std::map<std::string, std::string> get_str_map(const json& j, const char* key) {
    std::map<std::string, std::string> m;
    auto it = j.find(key);
    if (it == j.end() || !it->is_object()) {
        return m;
    }
    for (auto v = it->begin(); v != it->end(); ++v) {
        if (v.value().is_string()) {
            m[v.key()] = v.value().get<std::string>();
        }
    }
    return m;
}

void replace_all(std::string& s, const std::string& from, const std::string& to) {
    if (from.empty()) {
        return;
    }
    size_t pos = 0;
    while ((pos = s.find(from, pos)) != std::string::npos) {
        s.replace(pos, from.size(), to);
        pos += to.size();
    }
}

// ---------------------------------------------------------------------------
// 子进程执行（舵机命令，带超时）
// ---------------------------------------------------------------------------

struct CmdOutcome {
    bool ok = false;
    bool timed_out = false;
    int exit_code = -1;
    std::string err_tail;
};

std::vector<std::string> split_ws(const std::string& s) {
    std::vector<std::string> out;
    size_t i = 0;
    while (i < s.size()) {
        while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i]))) {
            ++i;
        }
        size_t j = i;
        while (j < s.size() && !std::isspace(static_cast<unsigned char>(s[j]))) {
            ++j;
        }
        if (j > i) {
            out.push_back(s.substr(i, j - i));
        }
        i = j;
    }
    return out;
}

std::string read_tail(const std::string& path, size_t n) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        return "";
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    std::string s = ss.str();
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) {
        s.pop_back();
    }
    if (s.size() > n) {
        s = s.substr(s.size() - n);
    }
    return s;
}

// posix_spawn 执行命令；stdout 丢弃，stderr 落 /tmp 供失败原因提取；超时 SIGKILL。
CmdOutcome run_command(const std::string& cmdline, int timeout_sec) {
    CmdOutcome out;
    std::vector<std::string> parts = split_ws(cmdline);
    if (parts.empty()) {
        out.err_tail = "空命令";
        return out;
    }
    std::string err_path =
        "/tmp/sorter_cpp_cmd_err_" + std::to_string(static_cast<long>(::getpid())) + ".log";
    std::vector<char*> argv;
    argv.reserve(parts.size() + 1);
    for (auto& p : parts) {
        argv.push_back(const_cast<char*>(p.c_str()));
    }
    argv.push_back(nullptr);

    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addopen(&fa, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
    posix_spawn_file_actions_addopen(&fa, STDERR_FILENO, err_path.c_str(),
                                     O_WRONLY | O_CREAT | O_TRUNC, 0644);

    pid_t pid = 0;
    int rc = posix_spawn(&pid, argv[0], &fa, nullptr, argv.data(), environ);
    posix_spawn_file_actions_destroy(&fa);
    if (rc != 0) {
        out.err_tail = std::string("spawn 失败: ") + std::strerror(rc);
        return out;
    }

    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(std::max(1, timeout_sec));
    int status = 0;
    for (;;) {
        pid_t w = ::waitpid(pid, &status, WNOHANG);
        if (w == pid) {
            break;
        }
        if (w < 0) {
            if (errno == EINTR) {
                continue;
            }
            out.err_tail = std::string("waitpid 失败: ") + std::strerror(errno);
            return out;
        }
        if (std::chrono::steady_clock::now() >= deadline) {
            ::kill(pid, SIGKILL);
            ::waitpid(pid, &status, 0);
            out.timed_out = true;
            out.err_tail = "timeout after " + std::to_string(timeout_sec) + "s";
            return out;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (WIFEXITED(status)) {
        out.exit_code = WEXITSTATUS(status);
        out.ok = (out.exit_code == 0);
    } else if (WIFSIGNALED(status)) {
        out.err_tail = "signal " + std::to_string(WTERMSIG(status));
    }
    if (!out.ok && out.err_tail.empty()) {
        std::string tail = read_tail(err_path, 200);
        out.err_tail = "exit=" + std::to_string(out.exit_code);
        if (!tail.empty()) {
            out.err_tail += " " + tail;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// 省份解析（与 Python engine.py parse_province 一致）
// ---------------------------------------------------------------------------

struct ProvinceEntry {
    const char* short_name;
    const char* full_name;
};

// 顺序与 Python 版一致（先匹配长前缀省份：“黑龙江/内蒙古/新疆/西藏/宁夏/广西”）
const ProvinceEntry kProvinceMap[] = {
    {"黑龙江", "黑龙江省"},       {"内蒙古", "内蒙古自治区"},
    {"新疆", "新疆维吾尔自治区"}, {"西藏", "西藏自治区"},
    {"宁夏", "宁夏回族自治区"},   {"广西", "广西壮族自治区"},
    {"北京", "北京市"},           {"天津", "天津市"},
    {"上海", "上海市"},           {"重庆", "重庆市"},
    {"河北", "河北省"},           {"山西", "山西省"},
    {"辽宁", "辽宁省"},           {"吉林", "吉林省"},
    {"江苏", "江苏省"},           {"浙江", "浙江省"},
    {"安徽", "安徽省"},           {"福建", "福建省"},
    {"江西", "江西省"},           {"山东", "山东省"},
    {"河南", "河南省"},           {"湖北", "湖北省"},
    {"湖南", "湖南省"},           {"广东", "广东省"},
    {"海南", "海南省"},           {"四川", "四川省"},
    {"贵州", "贵州省"},           {"云南", "云南省"},
    {"陕西", "陕西省"},           {"甘肃", "甘肃省"},
    {"青海", "青海省"},           {"台湾", "台湾省"},
    {"香港", "香港特别行政区"},   {"澳门", "澳门特别行政区"},
};

bool is_ascii_strip(unsigned char c) {
    if (c <= 0x20) {  // 空白 + 控制字符
        return true;
    }
    switch (c) {
        case ',':
        case '.':
        case ':':
        case ';':
        case '|':
        case '/':
        case '\\':
        case '-':
        case '_':
        case '(':
        case ')':
        case '[':
        case ']':
        case '\'':
        case '"':
            return true;
        default:
            return false;
    }
}

// Python: re.sub(r"[\s,，。.:：;；、|/\\\-_（）()\[\]【】'\"“”]", "", text)
const char* const kMultiStrip[] = {"，", "。", "：", "；", "、", "（", "）",
                                   "【", "】", "“", "”", "　"};

size_t utf8_seq_len(unsigned char c) {
    if (c < 0x80) {
        return 1;
    }
    if ((c >> 5) == 0x6) {
        return 2;
    }
    if ((c >> 4) == 0xE) {
        return 3;
    }
    if ((c >> 3) == 0x1E) {
        return 4;
    }
    return 1;
}

std::string strip_for_province(const std::string& text) {
    std::string out;
    out.reserve(text.size());
    size_t i = 0;
    while (i < text.size()) {
        unsigned char c = static_cast<unsigned char>(text[i]);
        if (c < 0x80) {
            if (!is_ascii_strip(c)) {
                out.push_back(static_cast<char>(c));
            }
            i += 1;
            continue;
        }
        bool stripped = false;
        for (const char* m : kMultiStrip) {
            size_t n = std::strlen(m);
            if (text.compare(i, n, m) == 0) {
                i += n;
                stripped = true;
                break;
            }
        }
        if (stripped) {
            continue;
        }
        size_t n = utf8_seq_len(c);
        if (i + n > text.size()) {
            n = 1;
        }
        out.append(text, i, n);
        i += n;
    }
    return out;
}

}  // namespace

// ---------------------------------------------------------------------------
// AppConfig
// ---------------------------------------------------------------------------

AppConfig load_config(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        throw std::runtime_error("无法打开配置文件: " + path);
    }
    json j;
    try {
        in >> j;
    } catch (const std::exception& e) {
        throw std::runtime_error(std::string("配置文件 JSON 解析失败: ") + e.what());
    }
    if (!j.is_object()) {
        throw std::runtime_error("配置文件根节点必须是 JSON 对象");
    }

    AppConfig cfg;

    // ---- camera ----
    const json& cam = get_section(j, "camera");
    cfg.camera.index = getv<int>(cam, "index", cfg.camera.index);
    cfg.camera.width = getv<int>(cam, "width", cfg.camera.width);
    cfg.camera.height = getv<int>(cam, "height", cfg.camera.height);
    cfg.camera.fps = getv<double>(cam, "fps", cfg.camera.fps);
    cfg.camera.fps_low = getv<double>(cam, "fps_low", cfg.camera.fps_low);
    cfg.camera.fps_high = getv<double>(cam, "fps_high", cfg.camera.fps_high);
    cfg.camera.cpu_high_ratio = getv<double>(cam, "cpu_high_ratio", cfg.camera.cpu_high_ratio);
    cfg.camera.fps_check_sec = getv<double>(cam, "fps_check_sec", cfg.camera.fps_check_sec);
    cfg.camera.fourcc = getv<std::string>(cam, "fourcc", cfg.camera.fourcc);

    // ---- detection ----
    const json& det = get_section(j, "detection");
    DetectionConfig& d = cfg.detection;
    d.hsv_lo = get_hsv(det, "hsv_lo", d.hsv_lo);
    d.hsv_hi = get_hsv(det, "hsv_hi", d.hsv_hi);
    d.roi_top = getv<int>(det, "roi_top", d.roi_top);
    d.close_ksize = getv<int>(det, "close_ksize", d.close_ksize);
    d.open_ksize = getv<int>(det, "open_ksize", d.open_ksize);
    d.min_area = getv<double>(det, "min_area", d.min_area);
    d.max_area = getv<double>(det, "max_area", d.max_area);
    d.min_w = getv<int>(det, "min_w", d.min_w);
    d.min_h = getv<int>(det, "min_h", d.min_h);
    d.max_aspect = getv<double>(det, "max_aspect", d.max_aspect);
    d.min_fill = getv<double>(det, "min_fill", d.min_fill);
    d.min_bottom = getv<int>(det, "min_bottom", d.min_bottom);
    d.max_bottom = getv<int>(det, "max_bottom", d.max_bottom);
    auto poly = det.find("roi_polygon");
    if (poly != det.end() && poly->is_array()) {
        d.roi_polygon.clear();
        for (const auto& p : *poly) {
            if (p.is_array() && p.size() >= 2) {
                try {
                    d.roi_polygon.emplace_back(p[0].get<int>(), p[1].get<int>());
                } catch (const std::exception&) {
                    // 忽略非法点
                }
            }
        }
    }

    // ---- belt / tracking -> SorterConfig ----
    const json& belt = get_section(j, "belt");
    const json& track = get_section(j, "tracking");
    SorterConfig& s = cfg.sorter;
    s.direction = getv<std::string>(belt, "direction", s.direction);
    s.tape_x = getv<int>(belt, "tape_x", s.tape_x);
    s.front_lead_px = getv<int>(belt, "front_lead_px", s.front_lead_px);
    s.back_lead_px = getv<int>(belt, "back_lead_px", s.back_lead_px);
    s.exit_margin_px = getv<int>(belt, "exit_margin_px", s.exit_margin_px);
    s.pass_margin_px = getv<int>(belt, "pass_margin_px", s.pass_margin_px);
    s.exit_timeout_sec = getv<double>(belt, "exit_timeout_sec", s.exit_timeout_sec);
    cfg.motor_cmd = getv<std::string>(belt, "motor_cmd", cfg.motor_cmd);
    s.max_miss_frames = getv<int>(track, "max_miss_frames", s.max_miss_frames);
    s.match_max_dist = getv<int>(track, "match_max_dist", s.match_max_dist);
    s.ghost_ttl_sec = getv<double>(track, "ghost_ttl_sec", s.ghost_ttl_sec);
    s.lost_grace_sec = getv<double>(track, "lost_grace_sec", s.lost_grace_sec);
    s.min_frames_to_lock = getv<int>(track, "min_frames_to_lock", s.min_frames_to_lock);
    s.stable_frames_to_lock = getv<int>(track, "stable_frames_to_lock", s.stable_frames_to_lock);
    s.min_visible_ratio = getv<double>(track, "min_visible_ratio", s.min_visible_ratio);
    s.max_width_jitter = getv<double>(track, "max_width_jitter", s.max_width_jitter);
    s.edge_margin_px = getv<int>(track, "edge_margin_px", s.edge_margin_px);
    s.cam_w = cfg.camera.width;
    s.cam_h = cfg.camera.height;

    // ---- llm ----
    const json& llm = get_section(j, "llm");
    cfg.llm.url = getv<std::string>(llm, "url", cfg.llm.url);
    if (!llm.contains("url") && llm.contains("endpoint")) {
        cfg.llm.url = getv<std::string>(llm, "endpoint", cfg.llm.url);
    }
    cfg.llm.timeout_sec = getv<int>(llm, "timeout_sec", cfg.llm.timeout_sec);
    cfg.llm.max_tokens = getv<int>(llm, "max_tokens", cfg.llm.max_tokens);
    cfg.llm.curl_timeout_sec = getv<int>(llm, "curl_timeout_sec", cfg.llm.curl_timeout_sec);

    std::map<std::string, std::string> category_map = get_str_map(llm, "category_map");
    if (category_map.empty()) {
        category_map = {{"本地快递", "省内"}, {"货运快递", "货运"}, {"空运快递", "空运"}};
    }
    s.category_map = category_map;

    // ---- servo ----
    const json& servo = get_section(j, "servo");
    if (servo.contains("cmd")) {
        const json& cmd = servo["cmd"];
        if (cmd.is_string()) {
            std::string v = cmd.get<std::string>();
            if (!v.empty()) {
                cfg.servo_cmd = v;
            }
        } else if (cmd.is_array()) {  // 兼容 Python 版列表写法
            std::string joined;
            for (const auto& part : cmd) {
                if (part.is_string()) {
                    if (!joined.empty()) {
                        joined += " ";
                    }
                    joined += part.get<std::string>();
                }
            }
            if (!joined.empty()) {
                cfg.servo_cmd = joined;
            }
        }
    }
    replace_all(cfg.servo_cmd, "{servo_id}", "{id}");
    cfg.servo_timeout_sec = getv<int>(servo, "timeout_sec", cfg.servo_timeout_sec);

    std::map<std::string, std::string> servo_ids = get_str_map(servo, "servo_ids");
    if (servo_ids.empty()) {
        servo_ids = {{"货运", "1"}, {"空运", "2"}};
    }
    s.servo_ids = servo_ids;

    // ---- ocr ----
    const json& ocr = get_section(j, "ocr");
    cfg.ocr.endpoint = getv<std::string>(ocr, "endpoint", cfg.ocr.endpoint);
    cfg.ocr.credentials_file =
        getv<std::string>(ocr, "credentials_file", cfg.ocr.credentials_file);
    cfg.ocr.timeout_sec = getv<int>(ocr, "timeout_sec", cfg.ocr.timeout_sec);
    cfg.ocr.rotate = getv<int>(ocr, "rotate", cfg.ocr.rotate);
    cfg.ocr.crop_pad_px = getv<int>(ocr, "crop_pad_px", cfg.ocr.crop_pad_px);
    cfg.ocr.capture_dir = getv<std::string>(ocr, "capture_dir", cfg.ocr.capture_dir);
    cfg.ocr.provider = getv<std::string>(ocr, "provider", cfg.ocr.provider);
    cfg.ocr.local_cmd = getv<std::string>(ocr, "local_cmd", cfg.ocr.local_cmd);
    cfg.ocr.tmp_dir = getv<std::string>(ocr, "tmp_dir", cfg.ocr.tmp_dir);

    // ---- logging ----
    const json& logging = get_section(j, "logging");
    cfg.log_file = getv<std::string>(logging, "file", cfg.log_file);

    return cfg;
}

// ---------------------------------------------------------------------------
// 摄像头 / 检测 / 省份解析
// ---------------------------------------------------------------------------

namespace hw {

cv::VideoCapture open_camera(const CameraConfig& cam) {
    cv::VideoCapture cap(cam.index, cv::CAP_V4L2);
    if (!cap.isOpened()) {
        return cap;
    }
    std::string fourcc = cam.fourcc.empty() ? "MJPG" : cam.fourcc;
    if (fourcc.size() == 4) {
        cap.set(cv::CAP_PROP_FOURCC,
                cv::VideoWriter::fourcc(fourcc[0], fourcc[1], fourcc[2], fourcc[3]));
    }
    cap.set(cv::CAP_PROP_FRAME_WIDTH, cam.width);
    cap.set(cv::CAP_PROP_FRAME_HEIGHT, cam.height);
    cap.set(cv::CAP_PROP_BUFFERSIZE, 1);
    return cap;
}

std::vector<cv::Rect> detect_boxes(const cv::Mat& frame, const DetectionConfig& det) {
    std::vector<cv::Rect> boxes;
    if (frame.empty()) {
        return boxes;
    }
    cv::Mat hsv;
    cv::cvtColor(frame, hsv, cv::COLOR_BGR2HSV);
    cv::Mat mask;
    cv::inRange(hsv, det.hsv_lo, det.hsv_hi, mask);
    if (det.roi_top > 0 && det.roi_top < mask.rows) {
        mask.rowRange(0, det.roi_top).setTo(0);
    }
    if (det.close_ksize > 0) {
        cv::Mat k = cv::getStructuringElement(
            cv::MORPH_RECT, cv::Size(det.close_ksize, det.close_ksize));
        cv::morphologyEx(mask, mask, cv::MORPH_CLOSE, k);
    }
    if (det.open_ksize > 0) {
        cv::Mat k =
            cv::getStructuringElement(cv::MORPH_RECT, cv::Size(det.open_ksize, det.open_ksize));
        cv::morphologyEx(mask, mask, cv::MORPH_OPEN, k);
    }
    if (!det.roi_polygon.empty()) {
        cv::Mat pm = cv::Mat::zeros(mask.size(), CV_8UC1);
        std::vector<std::vector<cv::Point>> polys{det.roi_polygon};
        cv::fillPoly(pm, polys, cv::Scalar(255));
        mask &= pm;
    }

    std::vector<std::vector<cv::Point>> contours;
    cv::findContours(mask, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);
    for (const auto& c : contours) {
        double area = cv::contourArea(c);
        if (area < det.min_area || area > det.max_area) {
            continue;
        }
        cv::Rect r = cv::boundingRect(c);
        if (r.width < det.min_w || r.height < det.min_h) {
            continue;
        }
        if (r.width / static_cast<double>(r.height) > det.max_aspect ||
            r.height / static_cast<double>(r.width) > det.max_aspect) {
            continue;
        }
        if (area / static_cast<double>(r.width * r.height) < det.min_fill) {
            continue;
        }
        if (det.min_bottom > 0 && r.y + r.height < det.min_bottom) {
            continue;   // 未进入皮带区域（背景纸箱墙）
        }
        if (det.max_bottom > 0 && r.y + r.height > det.max_bottom) {
            continue;   // 越过皮带近侧边缘（推杆条/舵机等杂物）
        }
        boxes.push_back(r);
    }
    return boxes;
}

std::string parse_province(const std::string& text) {
    std::string t = strip_for_province(text);
    for (const auto& e : kProvinceMap) {
        if (t.find(e.short_name) != std::string::npos) {
            return e.full_name;
        }
    }
    // 容错：相邻两字顺序颠倒（汉字 UTF-8 每字 3 字节，如“苏江”→“江苏”）
    for (const auto& e : kProvinceMap) {
        const std::string name = e.short_name;
        if (name.size() < 6 || name.size() % 3 != 0) continue;
        const size_t n = name.size() / 3;
        for (size_t i = 0; i + 1 < n; ++i) {
            std::string swapped = name;
            for (size_t k = 0; k < 3; ++k) {
                swapped[i * 3 + k] = name[(i + 1) * 3 + k];
                swapped[(i + 1) * 3 + k] = name[i * 3 + k];
            }
            if (t.find(swapped) != std::string::npos) {
                return e.full_name;
            }
        }
    }
    return "";
}

static std::string trim_tuning(const std::string& s) {
    const size_t b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return "";
    const size_t e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}

// tuning.yaml：扁平 key: value，覆盖触发/跟踪参数（优先级高于 sorter_cpp.json）
bool load_tuning_file(AppConfig& cfg, const std::string& path,
                      const std::function<void(const std::string&)>& log) {
    std::ifstream in(path);
    if (!in) {
        return false;
    }
    std::string line;
    int applied = 0;
    while (std::getline(in, line)) {
        const size_t hash = line.find('#');
        if (hash != std::string::npos) line = line.substr(0, hash);
        line = trim_tuning(line);
        if (line.empty()) continue;
        const size_t colon = line.find(':');
        if (colon == std::string::npos) continue;
        const std::string key = trim_tuning(line.substr(0, colon));
        const std::string val = trim_tuning(line.substr(colon + 1));
        if (key.empty() || val.empty()) continue;
        try {
            if (key == "tape_x") {
                cfg.sorter.tape_x = std::stoi(val);
            } else if (key == "front_lead_px") {
                cfg.sorter.front_lead_px = std::stoi(val);
            } else if (key == "back_lead_px") {
                cfg.sorter.back_lead_px = std::stoi(val);
            } else if (key == "min_visible_ratio") {
                cfg.sorter.min_visible_ratio = std::stod(val);
            } else if (key == "exit_margin_px") {
                cfg.sorter.exit_margin_px = std::stoi(val);
            } else if (key == "ocr_retry_pulse_sec") {
                cfg.sorter.ocr_retry_pulse_sec = std::stod(val);
            } else if (key == "ocr_max_attempts") {
                cfg.sorter.ocr_max_attempts = std::stoi(val);
            } else if (key == "ocr_fail_belt_run_sec") {
                cfg.sorter.ocr_fail_belt_run_sec = std::stod(val);
            } else if (key == "province_lost_stop_sec") {
                cfg.sorter.province_lost_stop_sec = std::stod(val);
            } else if (key == "province_max_run_sec") {
                cfg.sorter.province_max_run_sec = std::stod(val);
            } else if (key == "exit_timeout_sec") {
                cfg.sorter.exit_timeout_sec = std::stod(val);
            } else if (key == "max_miss_frames") {
                cfg.sorter.max_miss_frames = std::stoi(val);
            } else if (key == "match_max_dist") {
                cfg.sorter.match_max_dist = std::stoi(val);
            } else if (key == "ghost_ttl_sec") {
                cfg.sorter.ghost_ttl_sec = std::stod(val);
            } else if (key == "lost_grace_sec") {
                cfg.sorter.lost_grace_sec = std::stod(val);
            } else if (key == "min_frames_to_lock") {
                cfg.sorter.min_frames_to_lock = std::stoi(val);
            } else if (key == "stable_frames_to_lock") {
                cfg.sorter.stable_frames_to_lock = std::stoi(val);
            } else if (key == "max_width_jitter") {
                cfg.sorter.max_width_jitter = std::stod(val);
            } else if (key == "edge_margin_px") {
                cfg.sorter.edge_margin_px = std::stoi(val);
            } else if (key == "display_crop_x") {
                cfg.sorter.display_crop_x = std::stoi(val);
            } else if (key == "display_crop_y") {
                cfg.sorter.display_crop_y = std::stoi(val);
            } else if (key == "display_crop_w") {
                cfg.sorter.display_crop_w = std::stoi(val);
            } else if (key == "display_crop_h") {
                cfg.sorter.display_crop_h = std::stoi(val);
            } else if (key == "display_width") {
                cfg.sorter.display_width = std::stoi(val);
            } else if (key == "display_height") {
                cfg.sorter.display_height = std::stoi(val);
            } else if (key == "display_fps") {
                cfg.sorter.display_fps = std::stod(val);
            } else if (key == "display_flip") {
                cfg.sorter.display_flip =
                    (val[0] == '0' || val[0] == 'f' || val[0] == 'F') ? 0 : 1;
            } else if (key == "fps") {
                cfg.camera.fps = std::stod(val);
            } else if (key == "fps_low") {
                cfg.camera.fps_low = std::stod(val);
            } else if (key == "fps_high") {
                cfg.camera.fps_high = std::stod(val);
            } else if (key == "cpu_high_ratio") {
                cfg.camera.cpu_high_ratio = std::stod(val);
            } else if (key == "fps_check_sec") {
                cfg.camera.fps_check_sec = std::stod(val);
            } else {
                log("tuning.yaml: 未知键 " + key + "（已忽略）");
                continue;
            }
            ++applied;
        } catch (const std::exception&) {
            log("tuning.yaml: 数值解析失败 " + key + "=" + val);
        }
    }
    log("tuning.yaml 已加载（" + std::to_string(applied) + " 项）：tape_x=" +
        std::to_string(cfg.sorter.tape_x) + " front_lead=" +
        std::to_string(cfg.sorter.front_lead_px) + " back_lead=" +
        std::to_string(cfg.sorter.back_lead_px) + " visible=" +
        std::to_string(cfg.sorter.min_visible_ratio) + " retry_pulse=" +
        std::to_string(cfg.sorter.ocr_retry_pulse_sec) + " max_ocr=" +
        std::to_string(cfg.sorter.ocr_max_attempts) + " clear_sec=" +
        std::to_string(cfg.sorter.ocr_fail_belt_run_sec));
    return true;
}

}  // namespace hw

// ---------------------------------------------------------------------------
// RealBackends
// ---------------------------------------------------------------------------

RealBackends::RealBackends(const AppConfig& cfg, Engine* engine, LogFn log, bool no_servo)
    : cfg_(cfg),
      engine_(engine),
      log_(std::move(log)),
      no_servo_(no_servo),
      ocr_(cfg.ocr),
      llm_(cfg.llm) {}

void RealBackends::spawn_job(std::function<void()> job) {
    active_.fetch_add(1);
    std::thread([this, job = std::move(job)]() {
        try {
            job();
        } catch (const std::exception&) {
            // 各 job 内部已回调错误；兜底防止线程终止
        }
        active_.fetch_sub(1);
    }).detach();
}

void RealBackends::spawn_ocr_llm_job(std::function<void()> job) {
    ocr_llm_active_.fetch_add(1);
    spawn_job([this, job = std::move(job)]() {
        struct Guard {
            std::atomic<int>& n;
            ~Guard() { n.fetch_sub(1); }
        } guard{ocr_llm_active_};
        job();
    });
}

bool RealBackends::wait_idle(int timeout_ms) {
    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
    while (active_.load() > 0) {
        if (std::chrono::steady_clock::now() >= deadline) {
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    return true;
}

void RealBackends::submit_ocr(int pid, const cv::Mat& frame, const cv::Rect& box) {
    if (!engine_) {
        return;
    }
    const int dyn_pad = static_cast<int>(0.20 * std::min(box.width, box.height));
    const int pad = std::max(cfg_.ocr.crop_pad_px, dyn_pad);
    const int x0 = std::max(0, box.x - pad);
    const int y0 = std::max(0, box.y - pad);
    const int x1 = std::min(frame.cols, box.x + box.width + pad);
    const int y1 = std::min(frame.rows, box.y + box.height + pad);
    if (frame.empty() || x1 <= x0 || y1 <= y0) {
        spawn_ocr_llm_job([this, pid]() { engine_->handle_ocr_error(pid, "crop-invalid"); });
        return;
    }
    cv::Mat crop = frame(cv::Rect(x0, y0, x1 - x0, y1 - y0)).clone();
    if (cfg_.ocr.rotate == 180) {
        cv::rotate(crop, crop, cv::ROTATE_180);
    }
    std::string dir = cfg_.ocr.capture_dir;
    if (dir.empty()) {
        dir = cfg_.ocr.tmp_dir.empty() ? "/tmp" : cfg_.ocr.tmp_dir;
    }
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    char ts[32] = {0};
    std::time_t tt = std::time(nullptr);
    std::strftime(ts, sizeof(ts), "%Y%m%d_%H%M%S", std::localtime(&tt));
    std::string path = dir + "/" + ts + "_P" + std::to_string(pid) + ".jpg";
    std::vector<int> params{cv::IMWRITE_JPEG_QUALITY, 92};
    if (!cv::imwrite(path, crop, params)) {
        spawn_ocr_llm_job([this, pid, path]() { engine_->handle_ocr_error(pid, "imwrite 失败: " + path); });
        return;
    }
    spawn_ocr_llm_job([this, pid, path]() {
        try {
            std::string text = ocr_.recognize(path);
            log_("P" + std::to_string(pid) + " OCR 截图: " + path + " 文本: '" + text + "'");
            engine_->handle_ocr_text(pid, text);
        } catch (const std::exception& e) {
            engine_->handle_ocr_error(pid, e.what());
        }
    });
}

void RealBackends::submit_llm(int pid, const std::string& province) {
    if (!engine_) {
        return;
    }
    {
        std::lock_guard<std::mutex> lk(llm_cache_mu_);
        auto it = llm_cache_.find(province);
        if (it != llm_cache_.end()) {
            const std::string raw = it->second;
            if (log_) {
                log_("P" + std::to_string(pid) + " LLM 缓存命中: " + province);
            }
            spawn_ocr_llm_job([this, pid, raw]() { engine_->handle_llm_text(pid, raw); });
            return;
        }
    }
    spawn_ocr_llm_job([this, pid, province]() {
        std::string shipping;
        std::string err;
        if (llm_.classify(province, shipping, err)) {
            nlohmann::json j{{"shipping", shipping}};
            const std::string raw = j.dump();
            {
                std::lock_guard<std::mutex> lk(llm_cache_mu_);
                llm_cache_[province] = raw;
            }
            engine_->handle_llm_text(pid, raw);
        } else {
            engine_->handle_llm_error(pid, err);
        }
    });
}

void RealBackends::submit_servo(int pid, const std::string& servo_id) {
    if (!engine_) {
        return;
    }
    if (no_servo_) {
        if (log_) {
            log_("P" + std::to_string(pid) + " [no-servo] 应触发舵机 " + servo_id + "（未动作）");
        }
        engine_->handle_servo_result(pid, true, "");
        return;
    }
    spawn_job([this, pid, servo_id]() {
        std::string cmd = cfg_.servo_cmd;
        replace_all(cmd, "{id}", servo_id);
        if (log_) {
            log_("P" + std::to_string(pid) + " 执行舵机命令: " + cmd);
        }
        CmdOutcome res = run_command(cmd, cfg_.servo_timeout_sec);
        engine_->handle_servo_result(pid, res.ok, res.ok ? "" : res.err_tail);
    });
}

// ---------------------------------------------------------------------------
// FakeBackends
// ---------------------------------------------------------------------------

namespace {

std::string ship_by_category(const std::string& category) {
    if (category == "省内") {
        return "本地快递";
    }
    if (category == "空运") {
        return "空运快递";
    }
    return "货运快递";  // "货运" 及默认
}

}  // namespace

FakeBackends::FakeBackends(Engine* engine, LogFn log, std::string category, std::string province)
    : engine_(engine),
      log_(std::move(log)),
      category_(std::move(category)),
      province_(std::move(province)) {}

void FakeBackends::submit_ocr(int pid, const cv::Mat&, const cv::Rect&) {
    totals_.ocr += 1;
    if (engine_) {
        engine_->handle_ocr_text(pid, province_);
    }
}

void FakeBackends::submit_llm(int pid, const std::string&) {
    totals_.llm += 1;
    if (engine_) {
        nlohmann::json j{{"shipping", ship_by_category(category_)}};
        engine_->handle_llm_text(pid, j.dump());
    }
}

void FakeBackends::submit_servo(int pid, const std::string&) {
    totals_.servo += 1;
    if (engine_) {
        engine_->handle_servo_result(pid, true, "");
    }
}
