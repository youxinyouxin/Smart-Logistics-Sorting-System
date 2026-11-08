#pragma once
#include <map>
#include <string>
#include <vector>
#include <functional>
#include <opencv2/core.hpp>

struct SorterConfig {
    std::string direction = "rtl";   // "ltr" | "rtl"
    int tape_x = 599;
    int front_lead_px = 0;   // 前沿触发线额外偏移（货运，正=提前触发）
    int back_lead_px = 0;    // 后沿触发线额外偏移（空运，负=延后触发）
    int exit_margin_px = 140;
    int pass_margin_px = 120;
    double exit_timeout_sec = 12.0;
    int max_miss_frames = 5;
    int match_max_dist = 130;
    double ghost_ttl_sec = 2.5;
    double lost_grace_sec = 5.0;   // 活动件丢失后的宽限期（保留串行、等待恢复/分类）
    int min_frames_to_lock = 2;
    int stable_frames_to_lock = 3;   // 连续尺寸稳定帧数（放置未稳时不锁定）
    double min_visible_ratio = 0.88;
    double max_width_jitter = 0.15;
    int edge_margin_px = 100;
    int cam_w = 1280;
    int cam_h = 720;
    int ocr_max_attempts = 2;          // 单件最多 OCR 次数（省份未识别时脉冲后重试一次）
    double ocr_retry_pulse_sec = 0.5;  // 重试前传送带脉冲时长（秒）
    double ocr_fail_belt_run_sec = 5.0; // 第二次 OCR 仍失败时，传送带清出运行时长（秒）
    double province_lost_stop_sec = 1.0; // 省内件目标丢失后，再等多久停带（秒）
    double province_max_run_sec = 20.0;  // 省内件直通最长运行时间（安全兜底）
    // 实时显示：只裁剪传送带区域并缩小，降低卡顿
    int display_crop_x = 110;
    int display_crop_y = 230;
    int display_crop_w = 1169;
    int display_crop_h = 430;
    int display_width = 640;
    int display_height = 235;
    double display_fps = 3.0;   // 显示刷新上限（与处理帧率解耦）
    int display_flip = 1;       // 显示画面左右翻转（只影响显示）
    std::map<std::string, std::string> category_map; // 本地快递->省内, 货运快递->货运, 空运快递->空运
    std::map<std::string, std::string> servo_ids;    // 货运->1, 空运->2
};

class Backends {
public:
    virtual ~Backends() = default;
    virtual void submit_ocr(int pid, const cv::Mat& frame, const cv::Rect& box) = 0;
    virtual void submit_llm(int pid, const std::string& province) = 0;
    virtual void submit_servo(int pid, const std::string& servo_id) = 0;
};

class Engine {
public:
    using LogFn = std::function<void(const std::string&)>;
    using BeltFn = std::function<void(bool on)>;   // 传送带控制：true=启动电机, false=停止
    explicit Engine(const SorterConfig& cfg, LogFn log);
    void setBackends(Backends* b);
    void setBeltControl(BeltFn cb);

    // 主循环每帧调用（线程安全）
    void tick(const std::vector<cv::Rect>& boxes, const cv::Mat& frame, double now_sec);

    // 工作线程回调（线程安全，必须校验 pid）
    void handle_ocr_text(int pid, const std::string& text);
    void handle_ocr_error(int pid, const std::string& reason);
    void handle_llm_text(int pid, const std::string& raw);
    void handle_llm_error(int pid, const std::string& reason);
    void handle_servo_result(int pid, bool ok, const std::string& reason);
    void camera_lost(double now_sec);

    // 测试/状态查询
    struct Stat { int pid = 0; int ocr_calls = 0; std::string province, category, servo, result, reason; };
    struct TrackView { int pid = 0; int x = 0, y = 0, w = 0, h = 0;
                       bool active = false; std::string status, category; };
    struct SortRecord { int pid = 0; int ocr_calls = 0;
                        std::string province, category, servo, result; };
    using RecordFn = std::function<void(const SortRecord&)>;
    void setRecordCallback(RecordFn cb);
    std::map<int, Stat> stats() const;
    std::vector<TrackView> track_views() const;   // 当前画面中的跟踪框（用于实时显示）
    int active_pid() const;   // -1 表示无活动件
private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};
