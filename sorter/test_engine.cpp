// test_engine.cpp —— 引擎模拟测试（不依赖摄像头/OCR/LLM/舵机）
//
// 移植自 test_engine.py 全部 11 组场景（26 项断言），并新增 2 组 rtl 场景：
//   省内直通、货运前端触发、空运后端触发、连续帧 OCR 去重、跨帧越线、
//   OCR 超时、LLM 非法输出、连续两件串行、短暂丢跟踪恢复、分类晚到（已越线）、
//   首帧已越线跳过、rtl 货运前沿触发、rtl 空运后沿触发。
#include <memory>
#include "engine.hpp"

#include <algorithm>
#include <cstdio>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

static const double DT = 1.0 / 3.0;
static const char* PROVINCE_XJ = "新疆维吾尔自治区";

// ------------------------------------------------------------------ 配置
static SorterConfig cfg_ltr() {
    // 与 test_engine.py 的 CFG 完全对应（Python 缺省值 edge_margin=160 / visible=0.75 / jitter=0.15）
    SorterConfig c;
    c.direction = "ltr";
    c.tape_x = 525;
    c.exit_margin_px = 140;
    c.pass_margin_px = 120;
    c.exit_timeout_sec = 2.0;
    c.max_miss_frames = 5;
    c.match_max_dist = 130;
    c.ghost_ttl_sec = 2.5;
    c.min_frames_to_lock = 2;
    c.min_visible_ratio = 0.75;
    c.max_width_jitter = 0.15;
    c.edge_margin_px = 160;
    c.cam_w = 1280;
    c.cam_h = 720;
    c.category_map = {{"本地快递", "省内"}, {"货运快递", "货运"}, {"空运快递", "空运"}};
    c.servo_ids = {{"货运", "1"}, {"空运", "2"}};
    return c;
}

static SorterConfig cfg_rtl() {
    // rtl：包裹自右向左（x 递减）；货运看前沿 x，空运看后沿 x+w
    SorterConfig c;
    c.direction = "rtl";
    c.tape_x = 700;
    c.exit_margin_px = 140;
    c.pass_margin_px = 120;
    c.exit_timeout_sec = 2.0;
    c.max_miss_frames = 5;
    c.match_max_dist = 130;
    c.ghost_ttl_sec = 2.5;
    c.min_frames_to_lock = 2;
    c.min_visible_ratio = 0.75;
    c.max_width_jitter = 0.15;
    c.edge_margin_px = 160;
    c.cam_w = 1280;
    c.cam_h = 720;
    c.category_map = {{"本地快递", "省内"}, {"货运快递", "货运"}, {"空运快递", "空运"}};
    c.servo_ids = {{"货运", "1"}, {"空运", "2"}};
    return c;
}

// ------------------------------------------------------------------ FakeBackends
struct FakeBackends : Backends {
    std::vector<std::pair<int, cv::Rect>> ocr_pending;
    std::vector<std::pair<int, std::string>> llm_pending;
    std::vector<std::pair<int, std::string>> servo_pending;
    int ocr_total = 0;
    int llm_total = 0;
    int servo_total = 0;

    void submit_ocr(int pid, const cv::Mat&, const cv::Rect& box) override {
        ++ocr_total;
        ocr_pending.emplace_back(pid, box);
    }
    void submit_llm(int pid, const std::string& province) override {
        ++llm_total;
        llm_pending.emplace_back(pid, province);
    }
    void submit_servo(int pid, const std::string& servo_id) override {
        ++servo_total;
        servo_pending.emplace_back(pid, servo_id);
    }
};

struct Ctx {
    std::vector<std::string> logs;
    FakeBackends be;
    std::unique_ptr<Engine> e;

    explicit Ctx(const SorterConfig& cfg) {
        e.reset(new Engine(cfg, [this](const std::string& m) { logs.push_back(m); }));
        e->setBackends(&be);
    }
};

// ------------------------------------------------------------------ 工具
static bool any_log(const std::vector<std::string>& logs, const std::string& sub) {
    for (const auto& m : logs) {
        if (m.find(sub) != std::string::npos) return true;
    }
    return false;
}

static int count_log(const std::vector<std::string>& logs, const std::string& sub) {
    int n = 0;
    for (const auto& m : logs) {
        if (m.find(sub) != std::string::npos) ++n;
    }
    return n;
}

static std::string join_logs(const std::vector<std::string>& logs) {
    std::string s;
    for (const auto& m : logs) {
        s += m;
        s += "\n";
    }
    return s;
}

static std::string tail_logs(const std::vector<std::string>& logs, size_t n = 3) {
    std::string s;
    const size_t b = logs.size() > n ? logs.size() - n : 0;
    for (size_t i = b; i < logs.size(); ++i) {
        s += "| " + logs[i];
    }
    return s;
}

static std::string ship_of(const std::string& cat) {
    if (cat == "省内") return "本地快递";
    if (cat == "货运") return "货运快递";
    if (cat == "空运") return "空运快递";
    return cat;
}

static std::string json_shipping(const std::string& shipping) {
    return std::string("{\"shipping\": \"") + shipping + "\"}";
}

// 对应 auto_respond：把挂起的 OCR/LLM/舵机结果人工投递回引擎
static void auto_respond(Ctx& c, const std::string& category,
                         const std::string& province = PROVINCE_XJ, bool hold_llm = false) {
    while (!c.be.ocr_pending.empty()) {
        auto p = c.be.ocr_pending.front();
        c.be.ocr_pending.erase(c.be.ocr_pending.begin());
        c.e->handle_ocr_text(p.first, province);
    }
    if (!hold_llm && !category.empty()) {
        while (!c.be.llm_pending.empty()) {
            auto p = c.be.llm_pending.front();
            c.be.llm_pending.erase(c.be.llm_pending.begin());
            c.e->handle_llm_text(p.first, json_shipping(ship_of(category)));
        }
    }
    while (!c.be.servo_pending.empty()) {
        auto p = c.be.servo_pending.front();
        c.be.servo_pending.erase(c.be.servo_pending.begin());
        c.e->handle_servo_result(p.first, true, "");
    }
}

static void tick_at(Ctx& c, int x, double now, int w = 300, int y = 330, int h = 220) {
    std::vector<cv::Rect> boxes;
    boxes.emplace_back(x, y, w, h);
    c.e->tick(boxes, cv::Mat(), now);
}

static double run_parcel(Ctx& c, const std::string& category, int x0 = -200, int ticks = 40,
                         int speed = 40, int w = 300, bool hold_llm = false) {
    int x = x0;
    double now = 0.0;
    for (int i = 0; i < ticks; ++i) {
        now += DT;
        x += speed;
        tick_at(c, x, now, w);
        auto_respond(c, category, PROVINCE_XJ, hold_llm);
    }
    return now;
}

struct Checker {
    int passed = 0;
    int failed = 0;

    void check(const std::string& name, bool cond, const std::string& detail = "") {
        if (cond) {
            ++passed;
            std::printf("[PASS] %s\n", name.c_str());
        } else {
            ++failed;
            std::printf("[FAIL] %s  %s\n", name.c_str(), detail.c_str());
        }
    }
};

// ------------------------------------------------------------------ 场景 1：省内直通
static void test_local(Checker& ck) {
    Ctx c(cfg_ltr());
    std::vector<Engine::SortRecord> recs;
    c.e->setRecordCallback([&](const Engine::SortRecord& r) { recs.push_back(r); });
    int x = -200;
    double now = 0.0;
    for (int i = 0; i < 20; ++i) {          // 锁定、分类并启动传送带
        now += DT;
        x += 40;
        tick_at(c, x, now);
        auto_respond(c, "省内");
    }
    for (int i = 0; i < 15; ++i) {          // 目标离开画面，传送带应继续到消失后停机
        now += DT;
        c.e->tick(std::vector<cv::Rect>(), cv::Mat(), now);
    }
    ck.check("省内直通：OCR 1 次", c.be.ocr_total == 1, "ocr=" + std::to_string(c.be.ocr_total));
    ck.check("省内直通：不触发舵机", c.be.servo_total == 0, "servo=" + std::to_string(c.be.servo_total));
    ck.check("省内直通：完成", any_log(c.logs, "省内直通完成"), tail_logs(c.logs));
    ck.check("省内直通：完成记录 1 条",
             recs.size() == 1 && recs[0].province == PROVINCE_XJ &&
                 recs[0].category == "省内",
             "recs=" + std::to_string(recs.size()) +
                 (recs.empty() ? std::string() : (" prov=" + recs[0].province +
                                                   " cat=" + recs[0].category)));
}

// ------------------------------------------------------------------ 场景 2：货运（ltr 前沿触发）
static void test_freight(Checker& ck) {
    Ctx c(cfg_ltr());
    run_parcel(c, "货运", -200, 45);
    ck.check("货运：舵机 1 触发 1 次", c.be.servo_total == 1 && c.be.servo_pending.empty(),
             "servo=" + std::to_string(c.be.servo_total));
    ck.check("货运：触发的是 1 号", any_log(c.logs, "舵机 1"), tail_logs(c.logs, 5));
    ck.check("货运：完成", any_log(c.logs, "货运分拣完成") || any_log(c.logs, "异常件离开"),
             tail_logs(c.logs));
}

// ------------------------------------------------------------------ 场景 3：空运（ltr 后沿触发）
static void test_air(Checker& ck) {
    Ctx c(cfg_ltr());
    run_parcel(c, "空运", -200, 55);
    ck.check("空运：舵机 2 触发 1 次", c.be.servo_total == 1, "servo=" + std::to_string(c.be.servo_total));
    ck.check("空运：触发的是 2 号", any_log(c.logs, "舵机 2"), tail_logs(c.logs, 5));
}

// ------------------------------------------------------------------ 场景 4：连续 60 帧只 OCR/LLM 一次
static void test_ocr_once(Checker& ck) {
    Ctx c(cfg_ltr());
    run_parcel(c, "省内", -200, 60);
    ck.check("连续 60 帧：OCR 只提交 1 次", c.be.ocr_total == 1, "ocr=" + std::to_string(c.be.ocr_total));
    ck.check("连续 60 帧：LLM 只调用 1 次", c.be.llm_total == 1, "llm=" + std::to_string(c.be.llm_total));
}

// ------------------------------------------------------------------ 场景 5：跨帧越线
static void test_cross_jump(Checker& ck) {
    Ctx c(cfg_ltr());
    // 120px/帧：前沿仍会在单帧内跳过触发线；留足锁定跑道（稳定帧要求3）
    run_parcel(c, "货运", -600, 20, 120);
    ck.check("跨帧越线：仍触发且仅 1 次", c.be.servo_total == 1, "servo=" + std::to_string(c.be.servo_total));
    ck.check("跨帧越线：有触发日志", any_log(c.logs, "跨越触发线"), tail_logs(c.logs, 5));
}

// ------------------------------------------------------------------ 场景 6：OCR 超时
static void test_ocr_timeout(Checker& ck) {
    Ctx c(cfg_ltr());
    int x = -200;
    double now = 0.0;
    bool errored = false;
    for (int i = 0; i < 50; ++i) {
        now += DT;
        x += 40;
        tick_at(c, x, now);
        while (!c.be.ocr_pending.empty()) {
            auto p = c.be.ocr_pending.front();
            c.be.ocr_pending.erase(c.be.ocr_pending.begin());
            c.e->handle_ocr_error(p.first, "timeout");
            errored = true;
        }
        auto_respond(c, "");
        if (errored && c.e->active_pid() < 0) break;
    }
    ck.check("OCR 超时：进入异常", any_log(c.logs, "OCR 失败"), tail_logs(c.logs, 5));
    ck.check("OCR 超时：不重试（仍 1 次）", c.be.ocr_total == 1, "ocr=" + std::to_string(c.be.ocr_total));
    ck.check("OCR 超时：不调用 LLM/舵机", c.be.llm_total == 0 && c.be.servo_total == 0,
             "llm=" + std::to_string(c.be.llm_total) + " servo=" + std::to_string(c.be.servo_total));
}

// ------------------------------------------------------------------ 场景 7：LLM 非法输出
static void test_llm_invalid(Checker& ck) {
    Ctx c(cfg_ltr());
    int x = -200;
    double now = 0.0;
    for (int i = 0; i < 50; ++i) {
        now += DT;
        x += 40;
        tick_at(c, x, now);
        while (!c.be.ocr_pending.empty()) {
            auto p = c.be.ocr_pending.front();
            c.be.ocr_pending.erase(c.be.ocr_pending.begin());
            c.e->handle_ocr_text(p.first, PROVINCE_XJ);
        }
        while (!c.be.llm_pending.empty()) {
            auto p = c.be.llm_pending.front();
            c.be.llm_pending.erase(c.be.llm_pending.begin());
            c.e->handle_llm_text(p.first, "今天天气不错");
        }
    }
    ck.check("LLM 非法输出：进入异常", any_log(c.logs, "LLM 输出非法"), tail_logs(c.logs, 5));
    ck.check("LLM 非法输出：不触发舵机", c.be.servo_total == 0, "servo=" + std::to_string(c.be.servo_total));
}

// ------------------------------------------------------------------ 场景 8：连续两件串行
static void test_two_parcels(Checker& ck) {
    Ctx c(cfg_ltr());
    int xa = -200, xb = -800;
    double now = 0.0;
    for (int i = 0; i < 80; ++i) {
        now += DT;
        xa += 40;
        xb += 40;
        std::vector<cv::Rect> boxes;
        if (xa + 300 > 0) boxes.emplace_back(xa, 330, 300, 220);
        if (xb + 300 > 0) boxes.emplace_back(xb, 330, 300, 220);
        c.e->tick(boxes, cv::Mat(), now);
        auto_respond(c, "货运");
    }
    const int lock_logs = count_log(c.logs, "锁定为当前快递");
    ck.check("连续两件：两件各 OCR 1 次", c.be.ocr_total == 2, "ocr=" + std::to_string(c.be.ocr_total));
    ck.check("连续两件：两件各触发 1 次舵机", c.be.servo_total == 2,
             "servo=" + std::to_string(c.be.servo_total));
    ck.check("连续两件：串行锁定（两件都锁定）", lock_logs == 2, std::to_string(lock_logs));
}

// ------------------------------------------------------------------ 场景 9：短暂丢跟踪
static void test_tracking_recovery(Checker& ck) {
    Ctx c(cfg_ltr());
    int x = -200;
    double now = 0.0;
    for (int i = 0; i < 8; ++i) {
        now += DT;
        x += 40;
        tick_at(c, x, now);
        auto_respond(c, "省内");
    }
    for (int i = 0; i < 2; ++i) {  // 丢失 2 帧
        now += DT;
        c.e->tick(std::vector<cv::Rect>(), cv::Mat(), now);
    }
    x += 80;
    for (int i = 0; i < 30; ++i) {
        now += DT;
        x += 40;
        tick_at(c, x, now);
        auto_respond(c, "省内");
    }
    const auto st = c.e->stats();
    const int pid = (st.size() == 1) ? st.begin()->first : -1;
    const bool only_one_pid =
        (st.size() == 1) && !any_log(c.logs, "P" + std::to_string(pid + 1) + " ");
    ck.check("短暂丢跟踪：不重复 OCR", c.be.ocr_total == 1, "ocr=" + std::to_string(c.be.ocr_total));
    ck.check("短暂丢跟踪：仅一个 pid", only_one_pid,
             "pids=" + std::to_string(st.size()) + " " + tail_logs(c.logs, 5));
}

// ------------------------------------------------------------------ 场景 10：分类晚到
static void test_llm_late(Checker& ck) {
    Ctx c(cfg_ltr());
    std::vector<bool> belt;
    c.e->setBeltControl([&](bool on) { belt.push_back(on); });
    int x = -200;
    double now = 0.0;
    std::vector<std::pair<int, std::string>> late;
    for (int i = 0; i < 30; ++i) {
        now += DT;
        x += 80;
        tick_at(c, x, now);
        while (!c.be.ocr_pending.empty()) {
            auto p = c.be.ocr_pending.front();
            c.be.ocr_pending.erase(c.be.ocr_pending.begin());
            c.e->handle_ocr_text(p.first, PROVINCE_XJ);
        }
        if (i < 8) continue;  // 暂不回复 LLM，让其晚到
        late.insert(late.end(), c.be.llm_pending.begin(), c.be.llm_pending.end());
        c.be.llm_pending.clear();
        if (!late.empty() && i == 8) {
            for (const auto& p : late) {
                c.e->handle_llm_text(p.first, json_shipping("货运快递"));
            }
        }
    }
    ck.check("分类晚到：仍触发舵机 1 次", c.be.servo_total == 1,
             "servo=" + std::to_string(c.be.servo_total));
    ck.check("分类晚到：不再判 missed-trigger", !any_log(c.logs, "missed-trigger"),
             tail_logs(c.logs, 5));
    ck.check("分类晚到：已越线不启动传送带", belt.empty(),
             "belt=" + std::to_string(belt.size()));
}

// ------------------------------------------------------------------ 场景 11：首帧已越线
static void test_created_past_tape(Checker& ck) {
    Ctx c(cfg_ltr());
    std::vector<bool> belt;
    c.e->setBeltControl([&](bool on) { belt.push_back(on); });
    int x = 700;
    double now = 0.0;
    for (int i = 0; i < 15; ++i) {
        now += DT;
        x += 40;
        tick_at(c, x, now);
        auto_respond(c, "货运");
    }
    ck.check("首帧已越线：仍执行 OCR", c.be.ocr_total == 1,
             "ocr=" + std::to_string(c.be.ocr_total));
    ck.check("首帧已越线：立即触发舵机 1 次", c.be.servo_total == 1,
             "servo=" + std::to_string(c.be.servo_total));
    ck.check("首帧已越线：不再跳过", !any_log(c.logs, "跳过"), tail_logs(c.logs, 5));
    ck.check("首帧已越线：已越过出口，不启动传送带", belt.empty(),
             "belt=" + std::to_string(belt.size()));
}

// ------------------------------------------------------------------ 场景 12：rtl 货运前沿触发
static void test_rtl_freight(Checker& ck) {
    Ctx c(cfg_rtl());
    run_parcel(c, "货运", 1000, 25, -40);
    ck.check("rtl 货运：舵机 1 触发 1 次", c.be.servo_total == 1 && c.be.servo_pending.empty(),
             "servo=" + std::to_string(c.be.servo_total));
    ck.check("rtl 货运：前沿跨越触发线 + 1 号舵机",
             any_log(c.logs, "货运：边缘跨越触发线，启动舵机 1"), tail_logs(c.logs, 5));
    ck.check("rtl 货运：完成", any_log(c.logs, "货运分拣完成"), tail_logs(c.logs));
}

// ------------------------------------------------------------------ 场景 13：rtl 空运后沿触发
static void test_rtl_air(Checker& ck) {
    Ctx c(cfg_rtl());
    run_parcel(c, "空运", 1000, 25, -40);
    ck.check("rtl 空运：舵机 2 触发 1 次", c.be.servo_total == 1, "servo=" + std::to_string(c.be.servo_total));
    ck.check("rtl 空运：后沿跨越触发线 + 2 号舵机",
             any_log(c.logs, "空运：边缘跨越触发线，启动舵机 2"), tail_logs(c.logs, 5));
    ck.check("rtl 空运：完成", any_log(c.logs, "空运分拣完成"), tail_logs(c.logs));
}

// 场景14：活动件丢失后宽限期内恢复（LLM 已出结果），应继续分拣
static void test_lost_grace_recovery(Checker& ck) {
    Ctx c(cfg_rtl());
    int x = 1250;
    double now = 0.0;
    for (int i = 0; i < 16; ++i) {          // 锁定并完成分类（货运）
        now += DT;
        x -= 20;
        tick_at(c, x, now);
        auto_respond(c, "货运");
    }
    for (int i = 0; i < 6; ++i) {           // 丢失 6 帧（>max_miss=5，<宽限5s）
        now += DT;
        c.e->tick(std::vector<cv::Rect>(), cv::Mat(), now);
    }
    x -= 6 * 20;                            // 目标在遮挡期继续行进
    for (int i = 0; i < 30; ++i) {          // 恢复后继续到越线
        now += DT;
        x -= 20;
        tick_at(c, x, now);
        auto_respond(c, "货运");
    }
    ck.check("宽限恢复：未判失败", !any_log(c.logs, "目标丢失"), tail_logs(c.logs, 4));
    ck.check("宽限恢复：舵机1 恰好 1 次",
             c.be.servo_total == 1, "servo=" + std::to_string(c.be.servo_total));
    ck.check("宽限恢复：完成",
             any_log(c.logs, "货运分拣完成") || any_log(c.logs, "分拣已触发"), tail_logs(c.logs, 4));
    ck.check("宽限恢复：OCR 仍 1 次", c.be.ocr_total == 1, "ocr=" + std::to_string(c.be.ocr_total));
}

// 场景15：丢失超过宽限期，应判失败且不触发舵机
static void test_lost_grace_timeout(Checker& ck) {
    Ctx c(cfg_rtl());
    int x = 1250;
    double now = 0.0;
    for (int i = 0; i < 16; ++i) {
        now += DT;
        x -= 20;
        tick_at(c, x, now);
        auto_respond(c, "货运");
    }
    for (int i = 0; i < 24; ++i) {          // 丢失 8 秒 > 宽限 5 秒（从判丢时刻起算）
        now += DT;
        c.e->tick(std::vector<cv::Rect>(), cv::Mat(), now);
    }
    ck.check("宽限超时：判目标丢失", any_log(c.logs, "目标丢失"), tail_logs(c.logs, 4));
    ck.check("宽限超时：不触发舵机",
             c.be.servo_total == 0, "servo=" + std::to_string(c.be.servo_total));
}

// 场景16：OCR 文字相邻两字顺序颠倒（苏江省）仍应识别为江苏省并送 LLM
static void test_swap_province(Checker& ck) {
    Ctx c(cfg_ltr());
    int x = -200;
    double now = 0.0;
    for (int i = 0; i < 12; ++i) {
        now += DT;
        x += 40;
        tick_at(c, x, now);
    }
    bool submitted = false;
    while (!c.be.ocr_pending.empty()) {
        auto p = c.be.ocr_pending.front();
        c.be.ocr_pending.erase(c.be.ocr_pending.begin());
        c.e->handle_ocr_text(p.first, "苏江省");   // 顺序颠倒
        submitted = true;
    }
    bool province_ok = false;
    std::string llm_prov;
    for (const auto& kv : c.be.llm_pending) {
        llm_prov = kv.second;
        if (kv.second == "江苏省") province_ok = true;
    }
    for (const auto& kv : c.e->stats()) {
        if (kv.second.province == "江苏省") province_ok = true;
    }
    ck.check("顺序颠倒容错：已提交 OCR 并进入 LLM", submitted, "无 OCR 提交");
    ck.check("顺序颠倒容错：苏江省 -> 江苏省", province_ok, "llm_prov=" + llm_prov);
}

// 场景17：传送带自动控制（分类完成启动、流程结束停止）
static void test_belt_control(Checker& ck) {
    SorterConfig cfg = cfg_ltr();
    std::vector<std::string> logs;
    FakeBackends be;
    std::unique_ptr<Engine> e(new Engine(cfg, [&](const std::string& m) { logs.push_back(m); }));
    e->setBackends(&be);
    std::vector<bool> belt;
    e->setBeltControl([&](bool on) { belt.push_back(on); });

    auto drain = [&]() {
        while (!be.ocr_pending.empty()) {
            auto p = be.ocr_pending.front();
            be.ocr_pending.erase(be.ocr_pending.begin());
            e->handle_ocr_text(p.first, "广东省");
        }
        while (!be.llm_pending.empty()) {
            auto p = be.llm_pending.front();
            be.llm_pending.erase(be.llm_pending.begin());
            e->handle_llm_text(p.first, "{\"shipping\": \"本地快递\"}");
        }
        while (!be.servo_pending.empty()) {
            auto p = be.servo_pending.front();
            be.servo_pending.erase(be.servo_pending.begin());
            e->handle_servo_result(p.first, true, "");
        }
    };

    int x = -200;
    double now = 0.0;
    for (int i = 0; i < 20; ++i) {
        now += DT;
        x += 40;
        std::vector<cv::Rect> boxes{cv::Rect(x, 330, 300, 220)};
        e->tick(boxes, cv::Mat(), now);
        drain();
    }
    for (int i = 0; i < 15; ++i) {   // 目标离开画面
        now += DT;
        e->tick(std::vector<cv::Rect>(), cv::Mat(), now);
        drain();
    }
    int starts = 0;
    int stops = 0;
    for (bool on : belt) {
        if (on) {
            starts += 1;
        } else {
            stops += 1;
        }
    }
    ck.check("传送带：分类完成后启动 1 次", starts == 1, "starts=" + std::to_string(starts));
    ck.check("传送带：流程结束后停止", stops >= 1 && !belt.empty() && !belt.back(),
             "stops=" + std::to_string(stops));
}

// 场景18：省份未识别 → 0.5s 脉冲 → 重试 OCR 成功后才启动分拣
static void test_ocr_retry_success(Checker& ck) {
    Ctx c(cfg_ltr());
    std::vector<bool> belt;
    c.e->setBeltControl([&](bool on) { belt.push_back(on); });

    int x = -200;
    double now = 0.0;
    for (int i = 0; i < 12; ++i) {
        now += DT;
        x += 40;
        tick_at(c, x, now);
    }
    ck.check("重试成功：首次提交 OCR", c.be.ocr_total == 1,
             "ocr=" + std::to_string(c.be.ocr_total));
    int pid = c.be.ocr_pending.front().first;
    c.be.ocr_pending.erase(c.be.ocr_pending.begin());
    c.e->handle_ocr_text(pid, "看不清");
    now += DT;
    tick_at(c, x, now);   // 下一帧启动重试脉冲
    ck.check("重试成功：未识别省份后传送带短脉冲", !belt.empty() && belt.back(),
             "belt=" + std::to_string(belt.size()));

    now += DT;
    tick_at(c, x, now);   // 脉冲进行中
    ck.check("重试成功：脉冲结束前不重复 OCR", c.be.ocr_total == 1,
             "ocr=" + std::to_string(c.be.ocr_total));

    for (int i = 0; i < 2; ++i) {
        now += DT;
        tick_at(c, x, now);
    }
    ck.check("重试成功：脉冲结束后重试 OCR 1 次", c.be.ocr_total == 2,
             "ocr=" + std::to_string(c.be.ocr_total));
    ck.check("重试成功：脉冲已停止", !belt.empty() && !belt.back(),
             "belt=" + std::to_string(belt.size()));

    int pid2 = c.be.ocr_pending.front().first;
    c.be.ocr_pending.erase(c.be.ocr_pending.begin());
    c.e->handle_ocr_text(pid2, "广东省");
    int pid3 = c.be.llm_pending.front().first;
    c.be.llm_pending.erase(c.be.llm_pending.begin());
    c.e->handle_llm_text(pid3, json_shipping("本地快递"));
    now += DT;
    tick_at(c, x, now);

    auto st = c.e->stats();
    ck.check("重试成功：第二次识别出省份", st[pid2].province == "广东省",
             "province=" + st[pid2].province);
    ck.check("重试成功：OCR 共 2 次", st[pid2].ocr_calls == 2,
             "calls=" + std::to_string(st[pid2].ocr_calls));
    ck.check("重试成功：分类成功后传送带再次启动", !belt.empty() && belt.back(),
             "belt=" + std::to_string(belt.size()));
}

// 场景19：两次 OCR 均无法确定省份 → 异常清出，不触发舵机
static void test_ocr_retry_exhausted(Checker& ck) {
    Ctx c(cfg_ltr());
    std::vector<bool> belt;
    c.e->setBeltControl([&](bool on) { belt.push_back(on); });

    int x = -200;
    double now = 0.0;
    for (int i = 0; i < 12; ++i) {
        now += DT;
        x += 40;
        tick_at(c, x, now);
    }
    int pid = c.be.ocr_pending.front().first;
    c.be.ocr_pending.erase(c.be.ocr_pending.begin());
    c.e->handle_ocr_text(pid, "看不清");
    for (int i = 0; i < 4; ++i) {
        now += DT;
        tick_at(c, x, now);
    }
    ck.check("重试耗尽：第二次 OCR 已提交", c.be.ocr_total == 2,
             "ocr=" + std::to_string(c.be.ocr_total));
    int pid2 = c.be.ocr_pending.front().first;
    c.be.ocr_pending.erase(c.be.ocr_pending.begin());
    c.e->handle_ocr_text(pid2, "仍然看不清");
    ck.check("重试耗尽：未提交 LLM", c.be.llm_total == 0,
             "llm=" + std::to_string(c.be.llm_total));

    for (int i = 0; i < 9; ++i) {
        now += DT;
        tick_at(c, x, now);
    }
    auto st = c.e->stats();
    ck.check("重试耗尽：异常原因 province-not-found",
             st[pid].reason == "province-not-found", "reason=" + st[pid].reason);
    ck.check("重试耗尽：清出后传送带停止", !belt.empty() && !belt.back(),
             "belt=" + std::to_string(belt.size()));
}

// 场景20：第二次 OCR 失败后按 yaml 配置时长定时清出
static void test_ocr_fail_timed_clear(Checker& ck) {
    SorterConfig cfg = cfg_ltr();
    cfg.exit_timeout_sec = 10.0;       // 排除离场超时干扰，验证定时器
    cfg.ocr_fail_belt_run_sec = 0.7;
    Ctx c(cfg);
    std::vector<bool> belt;
    c.e->setBeltControl([&](bool on) { belt.push_back(on); });

    int x = -200;
    double now = 0.0;
    for (int i = 0; i < 12; ++i) {
        now += DT;
        x += 40;
        tick_at(c, x, now);
    }
    int pid = c.be.ocr_pending.front().first;
    c.be.ocr_pending.erase(c.be.ocr_pending.begin());
    c.e->handle_ocr_text(pid, "看不清");
    for (int i = 0; i < 4; ++i) {
        now += DT;
        tick_at(c, x, now);
    }
    int pid2 = c.be.ocr_pending.front().first;
    c.be.ocr_pending.erase(c.be.ocr_pending.begin());
    c.e->handle_ocr_text(pid2, "仍然看不清");

    now += DT;
    tick_at(c, x, now);   // 触发 fail_active，开始定时清出
    ck.check("定时清出：第二次失败后传送带启动", !belt.empty() && belt.back(),
             "belt=" + std::to_string(belt.size()));

    for (int i = 0; i < 4; ++i) {
        now += DT;
        tick_at(c, x, now);
    }
    ck.check("定时清出：到点停带并释放", !belt.empty() && !belt.back(),
             "belt=" + std::to_string(belt.size()));
    ck.check("定时清出：日志确认", any_log(c.logs, "清出计时结束"), tail_logs(c.logs, 4));
}

// ------------------------------------------------------------------ main
int main() {
    Checker ck;
    struct Case {
        const char* title;
        std::function<void(Checker&)> fn;
    };
    const Case cases[] = {
        {"场景1  省内直通", test_local},
        {"场景2  货运（ltr 前沿触发）", test_freight},
        {"场景3  空运（ltr 后沿触发）", test_air},
        {"场景4  连续 60 帧 OCR/LLM 各 1 次", test_ocr_once},
        {"场景5  跨帧越线仍触发且仅 1 次", test_cross_jump},
        {"场景6  OCR 超时", test_ocr_timeout},
        {"场景7  LLM 非法输出", test_llm_invalid},
        {"场景8  连续两件串行", test_two_parcels},
        {"场景9  短暂丢跟踪恢复", test_tracking_recovery},
        {"场景10 分类晚到仍立即触发", test_llm_late},
        {"场景11 首帧已越线仍触发", test_created_past_tape},
        {"场景12 rtl 货运前沿触发", test_rtl_freight},
        {"场景13 rtl 空运后沿触发", test_rtl_air},
        {"场景14 丢失宽限期内恢复", test_lost_grace_recovery},
        {"场景15 丢失宽限超时", test_lost_grace_timeout},
        {"场景16 OCR顺序颠倒容错", test_swap_province},
        {"场景17 传送带自动控制", test_belt_control},
        {"场景18 OCR失败重试成功", test_ocr_retry_success},
        {"场景19 OCR两次失败清出", test_ocr_retry_exhausted},
        {"场景20 OCR失败定时清出", test_ocr_fail_timed_clear},
    };
    for (const auto& cs : cases) {
        std::printf("\n== %s ==\n", cs.title);
        cs.fn(ck);
    }
    std::printf("\n结果：通过 %d 项，失败 %d 项\n", ck.passed, ck.failed);
    return ck.failed == 0 ? 0 : 1;
}
