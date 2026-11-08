// engine.cpp —— 分拣核心引擎（纯逻辑，C++17 逐行移植自已验证的 Python 版 engine.py）
//
// 单件串行状态机：
//   TRACKED(排队) → ACTIVE(OCR 提交→分类) → SERVO_LAUNCHED → EXIT_WAIT → DONE
// 异常：OCR/LLM/舵机/丢目标/晚到 → FAILED → 等离开(或超时) → 释放
//
// 说明：
//  - 日志字符串与 Python 版逐字一致（中文），时间戳由调用方前置，本文件不加。
//  - 线程安全：tick / handle_* / camera_lost / stats / active_pid 共用同一把 std::mutex。
//  - 后端回调（submit_ocr/submit_llm/submit_servo）在释放锁之后按顺序派发，
//    避免后端工作线程同步回调 handle_* 造成死锁；状态（如 SUBMITTED）在派发前已原子落定。
#include <memory>
#include "engine.hpp"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace {

// ===================== pid 计数器（与 Python Track._next_pid 一致） =====================
// Python 里是类变量：同一进程内所有引擎共享、从 1 递增。
std::atomic<int> g_next_pid{0};
inline int next_pid() { return ++g_next_pid; }

// ===================== UTF-8 工具（仅用于省份解析/日志 repr） =====================
void utf8_append(std::string& out, unsigned int cp) {
    if (cp < 0x80) {
        out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
        out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

std::vector<unsigned int> utf8_decode(const std::string& s) {
    std::vector<unsigned int> out;
    const size_t n = s.size();
    size_t i = 0;
    while (i < n) {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        if (c < 0x80) {
            out.push_back(c);
            ++i;
            continue;
        }
        int len = 0;
        unsigned int cp = 0;
        if ((c & 0xE0) == 0xC0) {
            len = 2;
            cp = c & 0x1Fu;
        } else if ((c & 0xF0) == 0xE0) {
            len = 3;
            cp = c & 0x0Fu;
        } else if ((c & 0xF8) == 0xF0) {
            len = 4;
            cp = c & 0x07u;
        } else {
            out.push_back(c);
            ++i;
            continue;
        }
        if (i + static_cast<size_t>(len) > n) {
            out.push_back(c);
            ++i;
            continue;
        }
        bool ok = true;
        for (int k = 1; k < len; ++k) {
            const unsigned char cc = static_cast<unsigned char>(s[i + static_cast<size_t>(k)]);
            if ((cc & 0xC0) != 0x80) {
                ok = false;
                break;
            }
            cp = (cp << 6) | (cc & 0x3Fu);
        }
        if (!ok) {
            out.push_back(c);
            ++i;
            continue;
        }
        out.push_back(cp);
        i += static_cast<size_t>(len);
    }
    return out;
}

// Python str.strip() 视为空白（ASCII + 全角空格）
bool is_strip_space(unsigned int cp) {
    return cp == ' ' || cp == '\t' || cp == '\n' || cp == '\r' || cp == '\f' || cp == '\v' ||
           cp == 0x00A0 || cp == 0x3000;
}

// parse_province 里 re 的删除字符类：[\s,，。.:：;；、|/\\\-_（）()\[\]【】'\"“”]
bool is_filter_char(unsigned int cp) {
    if (is_strip_space(cp)) return true;
    switch (cp) {
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
        case 0xFF0C:  // ，
        case 0x3002:  // 。
        case 0xFF1A:  // ：
        case 0xFF1B:  // ；
        case 0x3001:  // 、
        case 0xFF08:  // （
        case 0xFF09:  // ）
        case 0x3010:  // 【
        case 0x3011:  // 】
        case 0x201C:  // “
        case 0x201D:  // ”
            return true;
        default:
            return false;
    }
}

struct ProvinceEntry {
    const char* short_name;
    const char* full_name;
};

const ProvinceEntry kProvinceMap[] = {
    {"黑龙江", "黑龙江省"},       {"内蒙古", "内蒙古自治区"},   {"新疆", "新疆维吾尔自治区"},
    {"西藏", "西藏自治区"},       {"宁夏", "宁夏回族自治区"},   {"广西", "广西壮族自治区"},
    {"北京", "北京市"},           {"天津", "天津市"},           {"上海", "上海市"},
    {"重庆", "重庆市"},           {"河北", "河北省"},           {"山西", "山西省"},
    {"辽宁", "辽宁省"},           {"吉林", "吉林省"},           {"江苏", "江苏省"},
    {"浙江", "浙江省"},           {"安徽", "安徽省"},           {"福建", "福建省"},
    {"江西", "江西省"},           {"山东", "山东省"},           {"河南", "河南省"},
    {"湖北", "湖北省"},           {"湖南", "湖南省"},           {"广东", "广东省"},
    {"海南", "海南省"},           {"四川", "四川省"},           {"贵州", "贵州省"},
    {"云南", "云南省"},           {"陕西", "陕西省"},           {"甘肃", "甘肃省"},
    {"青海", "青海省"},           {"台湾", "台湾省"},           {"香港", "香港特别行政区"},
    {"澳门", "澳门特别行政区"},
};

std::optional<std::string> parse_province(const std::string& text) {
    std::string filtered;
    for (unsigned int cp : utf8_decode(text)) {
        if (is_filter_char(cp)) continue;
        utf8_append(filtered, cp);
    }
    for (const auto& e : kProvinceMap) {
        if (filtered.find(e.short_name) != std::string::npos) return std::string(e.full_name);
    }
    // 容错：相邻两字顺序颠倒（如“苏江”→“江苏”、“龙黑江”→“黑龙江”）
    for (const auto& e : kProvinceMap) {
        std::vector<unsigned int> cps = utf8_decode(e.short_name);
        if (cps.size() < 2) continue;
        for (size_t i = 0; i + 1 < cps.size(); ++i) {
            std::string swapped;
            for (size_t j = 0; j < cps.size(); ++j) {
                utf8_append(swapped, (j == i) ? cps[i + 1] : (j == i + 1 ? cps[i] : cps[j]));
            }
            if (filtered.find(swapped) != std::string::npos) return std::string(e.full_name);
        }
    }
    return std::nullopt;
}

// Python str.strip()
std::string py_strip(const std::string& s) {
    size_t b = 0;
    size_t e = s.size();
    while (b < e) {
        const unsigned char c = static_cast<unsigned char>(s[b]);
        if (c < 0x80) {
            if (!is_strip_space(c)) break;
            ++b;
            continue;
        }
        // 全角空格 U+3000 = E3 80 80
        if (b + 3 <= e && static_cast<unsigned char>(s[b]) == 0xE3 &&
            static_cast<unsigned char>(s[b + 1]) == 0x80 &&
            static_cast<unsigned char>(s[b + 2]) == 0x80) {
            b += 3;
            continue;
        }
        break;
    }
    while (e > b) {
        const unsigned char c = static_cast<unsigned char>(s[e - 1]);
        if (c < 0x80) {
            if (!is_strip_space(c)) break;
            --e;
            continue;
        }
        if (e >= b + 3 && static_cast<unsigned char>(s[e - 3]) == 0xE3 &&
            static_cast<unsigned char>(s[e - 2]) == 0x80 &&
            static_cast<unsigned char>(s[e - 1]) == 0x80) {
            e -= 3;
            continue;
        }
        break;
    }
    return s.substr(b, e - b);
}

// Python repr(str)：优先单引号；含 ' 且不含 " 时用双引号；其余按转义输出
std::string py_repr(const std::string& s) {
    const bool has_sq = s.find('\'') != std::string::npos;
    const bool has_dq = s.find('"') != std::string::npos;
    const char quote = (has_sq && !has_dq) ? '"' : '\'';
    std::string out;
    out.push_back(quote);
    for (char ch : s) {
        const unsigned char c = static_cast<unsigned char>(ch);
        if (c == '\\') {
            out += "\\\\";
        } else if (c == static_cast<unsigned char>(quote)) {
            out.push_back('\\');
            out.push_back(static_cast<char>(c));
        } else if (c == '\n') {
            out += "\\n";
        } else if (c == '\t') {
            out += "\\t";
        } else if (c == '\r') {
            out += "\\r";
        } else if (c < 0x20 || c == 0x7F) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\x%02x", static_cast<unsigned int>(c));
            out += buf;
        } else {
            out.push_back(static_cast<char>(c));
        }
    }
    out.push_back(quote);
    return out;
}

// 与 Python 的 `re.search(r'"shipping"\s*:\s*"([^"]*)"', raw)` 等价
std::optional<std::string> extract_shipping(const std::string& raw) {
    static const std::string kKey = "\"shipping\"";
    const size_t n = raw.size();
    size_t pos = raw.find(kKey);
    while (pos != std::string::npos) {
        size_t i = pos + kKey.size();
        while (i < n && (raw[i] == ' ' || raw[i] == '\t' || raw[i] == '\n' || raw[i] == '\r' ||
                         raw[i] == '\f' || raw[i] == '\v')) {
            ++i;
        }
        if (i < n && raw[i] == ':') {
            ++i;
            while (i < n && (raw[i] == ' ' || raw[i] == '\t' || raw[i] == '\n' || raw[i] == '\r' ||
                             raw[i] == '\f' || raw[i] == '\v')) {
                ++i;
            }
            if (i < n && raw[i] == '"') {
                const size_t end = raw.find('"', i + 1);
                if (end != std::string::npos) return raw.substr(i + 1, end - i - 1);
            }
        }
        pos = raw.find(kKey, pos + kKey.size());
    }
    return py_strip(raw);
}

}  // namespace

// =====================================================================================
// Impl
// =====================================================================================
struct Engine::Impl {
    // ---------------- 状态枚举（与 Python 字符串一一对应） ----------------
    enum class Status { TRACKED, ACTIVE, SKIPPED, FAILED, DONE };
    enum class OcrState { NONE, SUBMITTED, DONE, FAILED };
    enum class ServoState { NONE, LAUNCHED, DONE, FAILED };

    static const char* status_name(Status s) {
        switch (s) {
            case Status::TRACKED: return "TRACKED";
            case Status::ACTIVE: return "ACTIVE";
            case Status::SKIPPED: return "SKIPPED";
            case Status::FAILED: return "FAILED";
            case Status::DONE: return "DONE";
        }
        return "?";
    }
    static const char* ocr_name(OcrState s) {
        switch (s) {
            case OcrState::NONE: return "NONE";
            case OcrState::SUBMITTED: return "SUBMITTED";
            case OcrState::DONE: return "DONE";
            case OcrState::FAILED: return "FAILED";
        }
        return "?";
    }

    // ---------------- Track（对应 Python class Track） ----------------
    struct Track {
        int pid = 0;
        double x = 0, y = 0, w = 0, h = 0;      // 当前框（Python box 元组）
        double px = 0, py = 0, pw = 0, ph = 0;  // 上一帧框（Python prev）
        double vx = 0.0;
        double first_seen = 0.0;
        double last_seen = 0.0;
        int frames_seen = 1;
        int stable_frames = 0;   // 连续尺寸稳定帧数（放置未稳/手扶时不锁定）
        int missed = 0;
        double prev_w = 0.0;
        bool ghost = false;
        double ghost_until = 0.0;

        OcrState ocr_state = OcrState::NONE;
        int ocr_attempts = 0;              // 已提交 OCR 次数
        bool retry_pulse_pending = false;  // 下一帧启动重试脉冲（保证脉冲从帧时刻起算）
        std::optional<double> retry_at;    // 脉冲结束后重试 OCR 的时间点
        std::optional<std::string> province;
        std::optional<std::string> category;
        std::optional<std::string> fail_reason;

        ServoState servo_state = ServoState::NONE;
        std::optional<std::string> servo_id;

        Status status = Status::TRACKED;
        bool done = false;
        bool crossed_front = false;
        bool crossed_back = false;
        std::optional<long long> front_cross_frame;
        std::optional<long long> back_cross_frame;
        std::optional<double> exit_deadline;
        std::optional<double> clear_belt_until;   // 定时清出：到点停带并释放串行
        std::optional<double> pass_start;         // 省内件开始直通的时间（超时收尾用）

        Track(int id, double bx, double by, double bw, double bh, double now)
            : pid(id), x(bx), y(by), w(bw), h(bh),
              px(bx), py(by), pw(bw), ph(bh),
              first_seen(now), last_seen(now), prev_w(bw) {}

        double front(const std::string& direction) const { return direction == "ltr" ? x + w : x; }
        double back(const std::string& direction) const { return direction == "ltr" ? x : x + w; }
    };
    using TrackPtr = std::shared_ptr<Track>;

    struct StatRec {
        int pid = 0;
        int ocr_calls = 0;
        std::optional<std::string> province;
        std::optional<std::string> category;
        std::optional<std::string> servo;
        std::optional<std::string> result;
        std::optional<std::string> reason;
    };

    // 后端调用（锁外派发）
    struct OutCall {
        enum Kind { OCR, LLM, SERVO };
        Kind kind = OCR;
        int pid = 0;
        cv::Mat frame;
        cv::Rect box;
        std::string arg;
    };

    // ---------------- 数据 ----------------
    SorterConfig cfg;
    Engine::LogFn log;
    Backends* backends = nullptr;
    mutable std::mutex mtx;
    std::function<void(bool)> belt_cb;   // 传送带控制回调
    bool belt_on = false;
    std::optional<double> belt_pulse_until;   // 重试前的短脉冲截止时间
    Engine::RecordFn record_cb;               // 完成记录回调（写 JSON 用）

    std::vector<TrackPtr> tracks;
    std::vector<TrackPtr> ghosts;
    TrackPtr active;
    long long frame_no = 0;
    std::map<int, StatRec> stat_map;
    int failed_count = 0;
    std::vector<OutCall> outbox;

    Impl(const SorterConfig& c, Engine::LogFn l) : cfg(c), log(std::move(l)) {}

    // ---------------- 基础工具 ----------------
    void logline(const std::string& msg) {
        if (log) log(msg);
    }
    static std::string Ptag(int pid) { return "P" + std::to_string(pid); }
    static std::string or_none(const std::optional<std::string>& v) {
        return v ? *v : std::string("None");
    }

    StatRec& stat(int pid) {
        auto it = stat_map.find(pid);
        if (it == stat_map.end()) {
            StatRec s;
            s.pid = pid;
            it = stat_map.emplace(pid, s).first;
        }
        return it->second;
    }

    TrackPtr find(int pid) {
        if (active && active->pid == pid) return active;
        for (auto& t : tracks) {
            if (t->pid == pid) return t;
        }
        return nullptr;
    }

    static void dispatch(Backends* b, std::vector<OutCall>& calls) {
        if (!b) return;
        for (auto& c : calls) {
            if (c.kind == OutCall::OCR) {
                b->submit_ocr(c.pid, c.frame, c.box);
            } else if (c.kind == OutCall::LLM) {
                b->submit_llm(c.pid, c.arg);
            } else {
                b->submit_servo(c.pid, c.arg);
            }
        }
    }

    // ---------------- 匹配 ----------------
    // 对应 Python _match：按 vx 预测 x，取最近且小于动态阈值的未占用框
    int match_track(const TrackPtr& tr, const std::vector<cv::Rect>& boxes,
                    const std::vector<char>& used, double now) const {
        const double dt = std::max(now - tr->last_seen, 1e-3);
        const double predict = tr->x + tr->vx * dt;
        int best = -1;
        double best_d = 1e9;
        for (size_t i = 0; i < boxes.size(); ++i) {
            if (used[i]) continue;
            const double bx = boxes[i].x;
            const double bw = boxes[i].width;
            const double d = std::fabs(bx - predict);
            const double limit = std::max(static_cast<double>(cfg.match_max_dist),
                                          0.9 * std::max(bw, tr->w) + std::fabs(tr->vx) * dt * 0.6);
            if (d < best_d && d < limit) {
                best = static_cast<int>(i);
                best_d = d;
            }
        }
        return best;
    }

    // 对应 Python _match_ghost：在未过期 ghost 里找可继承的跟踪
    TrackPtr match_ghost(const cv::Rect& box, double now) {
        std::vector<TrackPtr> keep;
        keep.reserve(ghosts.size());
        for (auto& g : ghosts) {
            if (g->ghost_until > now || g == active) keep.push_back(g);
        }
        ghosts.swap(keep);
        for (size_t gi = 0; gi < ghosts.size(); ++gi) {
            TrackPtr g = ghosts[gi];
            const double dt = std::max(now - g->last_seen, 1e-3);
            const double predict = g->x + g->vx * dt;
            const double limit = std::max(static_cast<double>(cfg.match_max_dist),
                                          0.9 * std::max(static_cast<double>(box.width), g->w));
            if (std::fabs(static_cast<double>(box.x) - predict) < limit) {
                ghosts.erase(ghosts.begin() + static_cast<long>(gi));
                if (std::find(tracks.begin(), tracks.end(), g) == tracks.end()) tracks.push_back(g);
                return g;
            }
        }
        return nullptr;
    }

    double front_line() const { return cfg.tape_x + cfg.front_lead_px; }
    double back_line() const { return cfg.tape_x + cfg.back_lead_px; }

    // 分类已知时，该分类关注的边缘是否已经越过触发线（用于“越线也立即触发舵机”）
    bool past_trigger_line(const TrackPtr& t) const {
        if (!t->category) return false;
        const bool rtl = (cfg.direction == "rtl");
        if (*t->category == "货运") {
            return rtl ? t->front(cfg.direction) < front_line()
                       : t->front(cfg.direction) > front_line();
        }
        return rtl ? t->back(cfg.direction) < back_line()
                   : t->back(cfg.direction) > back_line();
    }

    // ---------------- 每帧：跟踪更新 ----------------
    void update_tracks(const std::vector<cv::Rect>& boxes, double now) {
        std::vector<char> used(boxes.size(), 0);
        for (auto& tr : tracks) {
            if (tr->ghost) continue;
            const int i = match_track(tr, boxes, used, now);
            if (i < 0) {
                tr->missed += 1;
                continue;
            }
            used[static_cast<size_t>(i)] = 1;
            const cv::Rect& b = boxes[static_cast<size_t>(i)];
            const double dt = std::max(now - tr->last_seen, 1e-3);
            tr->prev_w = tr->w;
            tr->vx = (static_cast<double>(b.x) - tr->x) / dt;
            tr->px = tr->x;
            tr->py = tr->y;
            tr->pw = tr->w;
            tr->ph = tr->h;
            tr->x = b.x;
            tr->y = b.y;
            tr->w = b.width;
            tr->h = b.height;
            {
                const double jw = std::fabs(tr->w - tr->pw) / std::max(1.0, std::max(tr->w, tr->pw));
                const double jh = std::fabs(tr->h - tr->ph) / std::max(1.0, std::max(tr->h, tr->ph));
                if (jw <= cfg.max_width_jitter && jh <= cfg.max_width_jitter) {
                    tr->stable_frames += 1;
                } else {
                    tr->stable_frames = 0;
                }
            }
            tr->last_seen = now;
            tr->frames_seen += 1;
            tr->missed = 0;
        }

        for (size_t i = 0; i < boxes.size(); ++i) {
            if (used[i]) continue;
            const cv::Rect& b = boxes[i];
            TrackPtr tr = match_ghost(b, now);
            if (!tr) {
                TrackPtr nt = std::make_shared<Track>(next_pid(), b.x, b.y, b.width, b.height, now);
                tracks.push_back(nt);
            } else {
                tr->ghost = false;
                tr->x = b.x;
                tr->y = b.y;
                tr->w = b.width;
                tr->h = b.height;
                // 恢复后把上一帧重置为当前帧，避免跨越遮挡期产生伪越线
                tr->px = tr->x;
                tr->py = tr->y;
                tr->pw = tr->w;
                tr->ph = tr->h;
                tr->last_seen = now;
                tr->frames_seen += 1;
                tr->missed = 0;
                tr->stable_frames = 0;
                logline(Ptag(tr->pid) + " 跟踪恢复（继承 " + status_name(tr->status) + "/" +
                        ocr_name(tr->ocr_state) + "）");
            }
        }
    }

    // ---------------- 每帧：越线判定 ----------------
    void update_crossings() {
        const bool ltr = (cfg.direction == "ltr");
        for (auto& t : tracks) {
            if (t->ghost) continue;
            if (ltr) {
                const double pf = t->px + t->pw;
                const double cf = t->x + t->w;
                const double pb = t->px;
                const double cb = t->x;
                if (!t->crossed_front && pf < front_line() && front_line() <= cf) {
                    t->crossed_front = true;
                    t->front_cross_frame = frame_no;
                }
                if (!t->crossed_back && pb < back_line() && back_line() <= cb) {
                    t->crossed_back = true;
                    t->back_cross_frame = frame_no;
                }
            } else {
                const double pf = t->px;
                const double cf = t->x;
                const double pb = t->px + t->pw;
                const double cb = t->x + t->w;
                if (!t->crossed_front && pf > front_line() && front_line() >= cf) {
                    t->crossed_front = true;
                    t->front_cross_frame = frame_no;
                }
                if (!t->crossed_back && pb > back_line() && back_line() >= cb) {
                    t->crossed_back = true;
                    t->back_cross_frame = frame_no;
                }
            }
        }
    }

    // ---------------- 每帧：过期清理 ----------------
    void expire(double now) {
        std::vector<TrackPtr> keep;
        keep.reserve(tracks.size());
        for (auto& t : tracks) {
            if (t->missed > cfg.max_miss_frames) {
                if (t == active && !t->done) {
                    if (t->servo_state == ServoState::LAUNCHED || t->servo_state == ServoState::DONE) {
                        t->done = true;
                        t->status = Status::DONE;
                        stat(t->pid).result = std::string("分拣已触发（目标离开画面）");
                        logline(Ptag(t->pid) + " 完成：舵机已触发（" + or_none(t->servo_id) +
                                "），目标离开画面");
                        emit_record(t, "分拣已触发（目标离开画面）");
                        active = nullptr;
                    } else {
                        // 宽限期：暂不判失败，保持 active（串行），等待目标恢复或分类结果
                        t->ghost = true;
                        double grace = cfg.lost_grace_sec;
                        if (t->category && *t->category == "省内") {
                            grace = cfg.province_lost_stop_sec;
                        }
                        t->ghost_until = now + grace;
                        ghosts.push_back(t);
                        logline(Ptag(t->pid) + " 目标暂时丢失，等待恢复（宽限期内）");
                        continue;
                    }
                }
                t->ghost = true;
                t->ghost_until = now + cfg.ghost_ttl_sec;
                ghosts.push_back(t);
                continue;
            }
            keep.push_back(t);
        }
        tracks.swap(keep);

        std::vector<TrackPtr> gkeep;
        gkeep.reserve(ghosts.size());
        for (auto& g : ghosts) {
            if (g->ghost_until > now || g == active) gkeep.push_back(g);
        }
        ghosts.swap(gkeep);
    }

    // ---------------- 锁定条件 ----------------
    bool ready_for_ocr(const Track& t) const {
        // ≥N 帧 + 中心距入画侧边缘≥edge_margin + 宽度稳定（排除手/遮挡/标签被裁）+ 可见率
        if (t.frames_seen < cfg.min_frames_to_lock) return false;
        if (t.prev_w > 0 &&
            std::fabs(t.w - t.prev_w) / std::max(t.w, t.prev_w) > cfg.max_width_jitter) {
            return false;
        }
        if (t.stable_frames < cfg.stable_frames_to_lock) return false;   // 放置稳定后才锁定
        const double cx = t.x + t.w / 2.0;
        if (cfg.direction == "rtl") {
            if (cx > cfg.cam_w - cfg.edge_margin_px) return false;
        } else {
            if (cx < cfg.edge_margin_px) return false;
        }
        const double visible = std::min(static_cast<double>(cfg.cam_w), t.x + t.w) - std::max(0.0, t.x);
        return visible >= cfg.min_visible_ratio * t.w;
    }

    // ---------------- 选活动件 ----------------
    void promote(const cv::Mat& frame) {
        if (active) return;
        TrackPtr best;
        for (auto& t : tracks) {
            if (t->ghost || t->done || t->status != Status::TRACKED) continue;
            if (t->ocr_state != OcrState::NONE) continue;
            if (!ready_for_ocr(*t)) continue;
            if (!best) {
                best = t;
                continue;
            }
            // ltr: 取 front 最大；rtl: 取 front 最小（相同时保留先出现者，与 Python max/min 一致）
            if (cfg.direction == "ltr") {
                if (t->front(cfg.direction) > best->front(cfg.direction)) best = t;
            } else {
                if (t->front(cfg.direction) < best->front(cfg.direction)) best = t;
            }
        }
        if (!best) return;
        best->status = Status::ACTIVE;
        active = best;
        best->ocr_state = OcrState::SUBMITTED;  // 原子标记后再提交
        best->ocr_attempts = 1;
        StatRec& st = stat(best->pid);
        st.ocr_calls += 1;
        logline(Ptag(best->pid) + " 锁定为当前快递，提交 OCR（本件第 1/" +
                std::to_string(cfg.ocr_max_attempts) + " 次）");
        OutCall c;
        c.kind = OutCall::OCR;
        c.pid = best->pid;
        c.frame = frame;
        c.box = cv::Rect(static_cast<int>(std::lround(best->x)), static_cast<int>(std::lround(best->y)),
                         static_cast<int>(std::lround(best->w)), static_cast<int>(std::lround(best->h)));
        outbox.push_back(std::move(c));
    }

    // ---------------- 完成/失败 ----------------
    void ensure_belt(bool on, const std::string& reason) {
        if (belt_on == on) return;
        belt_on = on;
        if (belt_cb) belt_cb(on);
        logline(std::string("传送带") + (on ? "启动" : "停止") + "（" + reason + "）");
    }

    bool passed_exit(const TrackPtr& t) const {
        if (cfg.direction == "ltr") return t->front(cfg.direction) > front_line() + cfg.exit_margin_px;
        return t->front(cfg.direction) < front_line() - cfg.exit_margin_px;
    }

    // 重试脉冲到点：停带，并推迟到下一帧（停带后的新图）再重试 OCR
    void update_retry_pulse(double now) {
        if (!belt_pulse_until || now < *belt_pulse_until) return;
        belt_pulse_until.reset();
        ensure_belt(false, "重试前脉冲结束");
        if (active && active->retry_at && *active->retry_at < now + 0.05) {
            active->retry_at = now + 0.05;
        }
    }

    // 在帧循环中启动重试脉冲，保证脉冲时长从当前帧时刻完整计算
    void start_retry_pulse(double now) {
        TrackPtr t = active;
        if (!t || t->ghost || !t->retry_pulse_pending) return;
        t->retry_pulse_pending = false;
        if (t->done || t->status != Status::ACTIVE || t->ocr_state != OcrState::NONE) return;
        t->retry_at = now + cfg.ocr_retry_pulse_sec;
        belt_pulse_until = now + cfg.ocr_retry_pulse_sec;
        ensure_belt(true, "OCR 未识别到省份，短脉冲");
    }

    // 省份未识别 → 脉冲后对同一件再提交一次 OCR（最多 cfg.ocr_max_attempts 次）
    void maybe_retry_ocr(const cv::Mat& frame, double now) {
        TrackPtr t = active;
        if (!t || t->done || t->status != Status::ACTIVE) return;
        if (t->ocr_state != OcrState::NONE || !t->retry_at || now < *t->retry_at) return;
        t->retry_at.reset();
        t->ocr_state = OcrState::SUBMITTED;
        t->ocr_attempts += 1;
        StatRec& st = stat(t->pid);
        st.ocr_calls += 1;
        logline(Ptag(t->pid) + " 重试 OCR（本件第 " + std::to_string(t->ocr_attempts) + "/" +
                std::to_string(cfg.ocr_max_attempts) + " 次）");
        OutCall c;
        c.kind = OutCall::OCR;
        c.pid = t->pid;
        c.frame = frame;
        c.box = cv::Rect(static_cast<int>(std::lround(t->x)), static_cast<int>(std::lround(t->y)),
                         static_cast<int>(std::lround(t->w)), static_cast<int>(std::lround(t->h)));
        outbox.push_back(std::move(c));
    }

    void finish(const TrackPtr& t, double /*now*/, const std::string& message) {
        t->done = true;
        t->status = Status::DONE;
        t->retry_at.reset();
        t->retry_pulse_pending = false;
        t->clear_belt_until.reset();
        StatRec& st = stat(t->pid);
        st.result = message;
        logline(Ptag(t->pid) + " 完成：" + message + "｜OCR " + std::to_string(st.ocr_calls) +
                " 次｜省份 " + or_none(st.province) + "｜分类 " + or_none(st.category) + "｜舵机 " +
                or_none(st.servo));
        emit_record(t, message);
        if (t == active) active = nullptr;
        belt_pulse_until.reset();
        ensure_belt(false, "流程结束");
    }

    void emit_record(const TrackPtr& t, const std::string& result) {
        if (!record_cb) return;
        Engine::SortRecord r;
        r.pid = t->pid;
        const StatRec& st = stat(t->pid);
        r.ocr_calls = st.ocr_calls;
        r.province = st.province.value_or("");
        r.category = st.category.value_or("");
        r.servo = st.servo.value_or("");
        r.result = result;
        record_cb(r);
    }

    void fail_active(const TrackPtr& t, const std::string& reason, double now,
                     bool timed_clear = false) {
        t->status = Status::FAILED;
        t->fail_reason = reason;
        t->retry_at.reset();
        t->retry_pulse_pending = false;
        stat(t->pid).reason = reason;
        failed_count += 1;
        t->exit_deadline = now + cfg.exit_timeout_sec;
        logline(Ptag(t->pid) + " 异常：" + reason + "（不触发，等待离开后处理下一件）");
        // 异常件若停在静止的皮带上，启动皮带清出；第二次 OCR 失败时按配置时长定时清出
        belt_pulse_until.reset();
        if (timed_clear) {
            t->clear_belt_until = now + cfg.ocr_fail_belt_run_sec;
            ensure_belt(true, "第二次识别失败，传送带清出 " +
                                  std::to_string(cfg.ocr_fail_belt_run_sec) + " 秒");
        } else {
            t->clear_belt_until.reset();
            ensure_belt(true, "异常件清出");
        }
    }

    // 货运/空运 → 舵机 id；配置缺失时按异常处理（Python 会抛 KeyError，这里转为可诊断失败）
    std::optional<std::string> servo_id_for(const std::string& category) const {
        auto it = cfg.servo_ids.find(category);
        if (it == cfg.servo_ids.end()) return std::nullopt;
        return it->second;
    }

    // ---------------- 驱动状态机 ----------------
    void drive(double now) {
        TrackPtr t = active;
        if (!t) return;

        if (t->ghost) {
            // 宽限期内等待目标恢复；省内件目标消失即视为直通完成
            if (now >= t->ghost_until) {
                if (t->category && *t->category == "省内") {
                    finish(t, now, "省内直通完成（目标离开画面）");
                    return;
                }
                t->status = Status::FAILED;
                if (!t->fail_reason) t->fail_reason = std::string("parcel-lost");
                stat(t->pid).reason = *t->fail_reason;
                failed_count += 1;
                logline(Ptag(t->pid) + " 目标丢失（" + *t->fail_reason + "），异常，不触发");
                active = nullptr;
            }
            return;
        }

        if (t->status == Status::ACTIVE) {
            if (t->ocr_state == OcrState::FAILED || t->servo_state == ServoState::FAILED) {
                const std::string reason =
                    t->fail_reason ? *t->fail_reason : std::string("unknown");
                fail_active(t, reason, now, reason == "province-not-found");
                return;
            }
            if (!t->category) return;

            if (*t->category == "省内") {
                if (!t->pass_start) t->pass_start = now;
                if (!belt_on) ensure_belt(true, "省内直通，启动传送带");
                // 一直运行到目标离开画面；超时仅作安全收尾
                if (now - *t->pass_start > cfg.province_max_run_sec) {
                    finish(t, now, "省内直通完成（超时收尾）");
                }
                return;
            }

            if (t->servo_state == ServoState::NONE) {
                const bool crossed =
                    (*t->category == "货运") ? t->crossed_front : t->crossed_back;
                // 分类返回时边缘已越线（放置/重试脉冲推进/晚到）：不启动传送带，立即触发舵机
                if (!crossed && !past_trigger_line(t)) {
                    if (!belt_on) ensure_belt(true, "省份与 LLM 分类成功，开始分拣");
                    return;
                }
                std::optional<std::string> sid = servo_id_for(*t->category);
                if (!sid) {
                    fail_active(t, "servo-id-missing:" + *t->category, now);
                    return;
                }
                const auto& cross_frame =
                    (*t->category == "货运") ? t->front_cross_frame : t->back_cross_frame;
                t->servo_state = ServoState::LAUNCHED;
                t->servo_id = *sid;
                stat(t->pid).servo = *sid;
                if (cross_frame && *cross_frame == frame_no) {
                    logline(Ptag(t->pid) + " " + *t->category + "：边缘跨越触发线，启动舵机 " + *sid);
                } else {
                    logline(Ptag(t->pid) + " " + *t->category +
                            "：已越过触发线，立即触发舵机 " + *sid + "（不启动传送带）");
                }
                OutCall c;
                c.kind = OutCall::SERVO;
                c.pid = t->pid;
                c.arg = *sid;
                outbox.push_back(std::move(c));
                return;
            }

            if (t->servo_state == ServoState::LAUNCHED) return;
            if (t->servo_state == ServoState::DONE) {
                if (passed_exit(t)) {
                    finish(t, now, *t->category + "分拣完成");
                    return;
                }
                if (!belt_on) ensure_belt(true, "舵机完成，传送带清出");
                return;
            }
        }

        if (t->status == Status::FAILED || t->status == Status::SKIPPED) {
            const bool clear_done =
                t->status == Status::FAILED && t->clear_belt_until && now >= *t->clear_belt_until;
            if (passed_exit(t) || clear_done || (t->exit_deadline && now >= *t->exit_deadline)) {
                if (t->status == Status::FAILED) {
                    if (clear_done) {
                        finish(t, now, "异常件清出计时结束（" + or_none(t->fail_reason) + "）");
                    } else {
                        finish(t, now, "异常件离开（" + or_none(t->fail_reason) + "）");
                    }
                } else {
                    t->done = true;
                    if (t == active) active = nullptr;
                }
            }
        }
    }

    // ---------------- 每帧入口 ----------------
    void tick(const std::vector<cv::Rect>& boxes, const cv::Mat& frame, double now) {
        std::vector<OutCall> calls;
        Backends* b = nullptr;
        {
            std::lock_guard<std::mutex> lk(mtx);
            frame_no += 1;
            update_tracks(boxes, now);
            update_crossings();
            expire(now);
            if (!active || active->done) {
                active = nullptr;
                promote(frame);
            }
            update_retry_pulse(now);
            start_retry_pulse(now);
            maybe_retry_ocr(frame, now);
            drive(now);
            if (!active && belt_on) {
                belt_pulse_until.reset();
                ensure_belt(false, "无活动件");
            }
            calls.swap(outbox);
            b = backends;
        }
        dispatch(b, calls);
    }

    // ---------------- 工作线程回调 ----------------
    void handle_ocr_text(int pid, const std::string& text) {
        std::vector<OutCall> calls;
        Backends* b = nullptr;
        {
            std::lock_guard<std::mutex> lk(mtx);
            TrackPtr t = find(pid);
            if (!t || t->ocr_state != OcrState::SUBMITTED) {
                logline(Ptag(pid) + " 忽略过期 OCR 结果");
                return;
            }
            std::optional<std::string> province = parse_province(text);
            if (!province) {
                if (t->ocr_attempts < cfg.ocr_max_attempts) {
                    // 省份未识别：下一帧起短脉冲挪动快递，停带后再试一次
                    t->ocr_state = OcrState::NONE;
                    t->retry_pulse_pending = true;
                    stat(pid).reason = std::string("province-not-found（等待重试）");
                    logline(Ptag(pid) + " 未能识别省份（" + py_repr(text) + "），准备脉冲后重试 OCR（第 " +
                            std::to_string(t->ocr_attempts + 1) + "/" +
                            std::to_string(cfg.ocr_max_attempts) + " 次）");
                } else {
                    t->ocr_state = OcrState::FAILED;
                    t->fail_reason = std::string("province-not-found");
                    stat(pid).reason = *t->fail_reason;
                    logline(Ptag(pid) + " OCR 已达 " + std::to_string(cfg.ocr_max_attempts) +
                            " 次仍无法确定省份（" + py_repr(text) + "），异常");
                }
                return;
            }
            t->province = *province;
            stat(pid).province = *province;
            logline(Ptag(pid) + " 省份=" + *province + "，提交 LLM 分类");
            OutCall c;
            c.kind = OutCall::LLM;
            c.pid = pid;
            c.arg = *province;
            outbox.push_back(std::move(c));
            calls.swap(outbox);
            b = backends;
        }
        dispatch(b, calls);
    }

    void handle_ocr_error(int pid, const std::string& reason) {
        std::lock_guard<std::mutex> lk(mtx);
        TrackPtr t = find(pid);
        if (!t || t->ocr_state != OcrState::SUBMITTED) return;
        t->ocr_state = OcrState::FAILED;
        t->fail_reason = "ocr-error:" + reason;
        stat(pid).reason = *t->fail_reason;
        logline(Ptag(pid) + " OCR 失败（不重试）: " + reason);
    }

    void handle_llm_text(int pid, const std::string& raw) {
        std::lock_guard<std::mutex> lk(mtx);
        TrackPtr t = find(pid);
        if (!t || t->ocr_state != OcrState::SUBMITTED || t->category) return;
        std::optional<std::string> value = extract_shipping(raw);
        std::optional<std::string> cat;
        if (value && !value->empty()) {
            auto it = cfg.category_map.find(py_strip(*value));
            if (it != cfg.category_map.end()) cat = it->second;
        }
        if (!cat) {
            t->ocr_state = OcrState::FAILED;
            t->fail_reason = "llm-invalid:" + py_repr(raw);
            stat(pid).reason = *t->fail_reason;
            logline(Ptag(pid) + " LLM 输出非法（" + py_repr(raw) + "），异常，不自行分流");
            return;
        }
        t->category = *cat;
        t->ocr_state = OcrState::DONE;
        stat(pid).category = *cat;
        logline(Ptag(pid) + " 分类=" + *cat);
    }

    void handle_llm_error(int pid, const std::string& reason) {
        std::lock_guard<std::mutex> lk(mtx);
        TrackPtr t = find(pid);
        if (!t || t->ocr_state != OcrState::SUBMITTED) return;
        t->ocr_state = OcrState::FAILED;
        t->fail_reason = "llm-error:" + reason;
        stat(pid).reason = *t->fail_reason;
        logline(Ptag(pid) + " LLM 失败: " + reason);
    }

    void handle_servo_result(int pid, bool ok, const std::string& reason) {
        std::lock_guard<std::mutex> lk(mtx);
        TrackPtr t = find(pid);
        if (!t) return;
        if (ok) {
            t->servo_state = ServoState::DONE;
            logline(Ptag(pid) + " 舵机 " + or_none(t->servo_id) + " 动作完成");
        } else {
            t->servo_state = ServoState::FAILED;
            t->fail_reason = "servo-error:" + reason;
            stat(pid).reason = *t->fail_reason;
            logline(Ptag(pid) + " 舵机异常: " + reason);
        }
    }

    // ---------------- 摄像头异常 ----------------
    void camera_lost(double now) {
        std::lock_guard<std::mutex> lk(mtx);
        if (active && !active->done && active->servo_state == ServoState::NONE) {
            fail_active(active, std::string("camera-lost"), now);
        }
        std::vector<TrackPtr> keep;
        keep.reserve(tracks.size());
        for (auto& t : tracks) {
            if (t->status == Status::DONE || t->status == Status::FAILED) keep.push_back(t);
        }
        tracks.swap(keep);
        logline("摄像头异常：camera-lost，清空未完成跟踪");
        belt_pulse_until.reset();
        ensure_belt(false, "摄像头异常");
    }

    // ---------------- 查询 ----------------
    std::map<int, Engine::Stat> stats() const {
        std::lock_guard<std::mutex> lk(mtx);
        std::map<int, Engine::Stat> out;
        for (const auto& kv : stat_map) {
            Engine::Stat s;
            s.pid = kv.second.pid;
            s.ocr_calls = kv.second.ocr_calls;
            s.province = kv.second.province.value_or("");
            s.category = kv.second.category.value_or("");
            s.servo = kv.second.servo.value_or("");
            s.result = kv.second.result.value_or("");
            s.reason = kv.second.reason.value_or("");
            out.emplace(kv.first, s);
        }
        return out;
    }

    int active_pid() const {
        std::lock_guard<std::mutex> lk(mtx);
        return active ? active->pid : -1;
    }

    std::vector<Engine::TrackView> track_views() const {
        std::lock_guard<std::mutex> lk(mtx);
        std::vector<Engine::TrackView> out;
        out.reserve(tracks.size());
        for (const auto& t : tracks) {
            if (t->ghost) continue;
            Engine::TrackView v;
            v.pid = t->pid;
            v.x = static_cast<int>(std::lround(t->x));
            v.y = static_cast<int>(std::lround(t->y));
            v.w = static_cast<int>(std::lround(t->w));
            v.h = static_cast<int>(std::lround(t->h));
            v.active = (t == active);
            v.status = status_name(t->status);
            if (t->category) v.category = *t->category;
            out.push_back(std::move(v));
        }
        return out;
    }
};

// =====================================================================================
// Engine 公共接口（全部转交 Impl，锁在 Impl 内部）
// =====================================================================================
Engine::Engine(const SorterConfig& cfg, LogFn log)
    : impl_(std::make_shared<Impl>(cfg, std::move(log))) {}

void Engine::setBackends(Backends* b) {
    std::lock_guard<std::mutex> lk(impl_->mtx);
    impl_->backends = b;
}

void Engine::setBeltControl(BeltFn cb) {
    std::lock_guard<std::mutex> lk(impl_->mtx);
    impl_->belt_cb = std::move(cb);
}

void Engine::setRecordCallback(RecordFn cb) {
    std::lock_guard<std::mutex> lk(impl_->mtx);
    impl_->record_cb = std::move(cb);
}

void Engine::tick(const std::vector<cv::Rect>& boxes, const cv::Mat& frame, double now_sec) {
    impl_->tick(boxes, frame, now_sec);
}

void Engine::handle_ocr_text(int pid, const std::string& text) { impl_->handle_ocr_text(pid, text); }
void Engine::handle_ocr_error(int pid, const std::string& reason) { impl_->handle_ocr_error(pid, reason); }
void Engine::handle_llm_text(int pid, const std::string& raw) { impl_->handle_llm_text(pid, raw); }
void Engine::handle_llm_error(int pid, const std::string& reason) { impl_->handle_llm_error(pid, reason); }
void Engine::handle_servo_result(int pid, bool ok, const std::string& reason) {
    impl_->handle_servo_result(pid, ok, reason);
}
void Engine::camera_lost(double now_sec) { impl_->camera_lost(now_sec); }

std::map<int, Engine::Stat> Engine::stats() const { return impl_->stats(); }
std::vector<Engine::TrackView> Engine::track_views() const { return impl_->track_views(); }
int Engine::active_pid() const { return impl_->active_pid(); }
