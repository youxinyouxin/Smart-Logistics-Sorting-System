// hw.hpp — 硬件层：配置、摄像头、纸箱检测、真实/假后端
#pragma once

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <opencv2/core.hpp>
#include <opencv2/videoio.hpp>

#include "engine.hpp"
#include "llm_client.hpp"
#include "ocr_client.hpp"

struct CameraConfig {
    int index = 20;
    int width = 1280;
    int height = 720;
    double fps = 3.0;        // 基准处理帧率（CPU 较高时）
    double fps_low = 1.5;    // OCR / LLM 忙时
    double fps_high = 6.0;   // 空闲且 CPU 低时
    double cpu_high_ratio = 0.65;
    double fps_check_sec = 1.0;
    std::string fourcc = "MJPG";
};

struct DetectionConfig {
    cv::Scalar hsv_lo{14, 40, 50};
    cv::Scalar hsv_hi{45, 215, 255};
    int roi_top = 220;
    std::vector<cv::Point> roi_polygon;  // 空=不启用
    int close_ksize = 21;
    int open_ksize = 7;
    double min_area = 8000;
    double max_area = 400000;
    int min_w = 100;
    int min_h = 60;
    double max_aspect = 4.0;
    double min_fill = 0.35;
    int min_bottom = 0;   // 检测框底部必须低于该 y（排除皮带上方背景纸箱）
    int max_bottom = 0;   // 检测框底部必须高于该 y（排除皮带近侧边缘外的推杆/舵机杂物）
};

// 完整应用配置（sorter_cpp.json）。sorter 为 engine.hpp 的固定契约结构。
struct AppConfig {
    SorterConfig sorter;
    CameraConfig camera;
    DetectionConfig detection;
    OcrConfig ocr;
    LlmConfig llm;
    std::string servo_cmd = "/root/sorter/servo_pwm set {id} on";
    int servo_timeout_sec = 15;
    std::string motor_cmd = "/usr/bin/python3 /root/sorter/belt_ctl.py daemon --gpio 70 --active-low";   // 传送带控制命令（{state}=on/off）
    std::string log_file = "/root/sorter_cpp/sorter.log";
};

// 读取 JSON 配置；文件缺失/非法时抛 std::runtime_error
AppConfig load_config(const std::string& path);

namespace hw {

// 摄像头：VideoCapture(index, CAP_V4L2)，MJPG，宽高，BUFFERSIZE=1
cv::VideoCapture open_camera(const CameraConfig& cam);

// 纸箱检测：inRange → roi_top 清零 → close → open → fillPoly 掩膜 → 轮廓过滤
std::vector<cv::Rect> detect_boxes(const cv::Mat& frame, const DetectionConfig& det);

// 省份规范化（与 Python engine.py parse_province 一致，34 个省级名称，短名匹配）。
// 未识别返回空串。
std::string parse_province(const std::string& text);

// 读取 tuning.yaml（扁平 key: value），覆盖 cfg 中的触发/跟踪参数；返回是否读取成功
bool load_tuning_file(AppConfig& cfg, const std::string& path,
                      const std::function<void(const std::string&)>& log);

}  // namespace hw

// 真实后端：OCR/LLM/舵机各自开 std::thread 执行，完成后回调 engine。
class RealBackends : public Backends {
public:
    using LogFn = std::function<void(const std::string&)>;

    // 构造时创建 OcrClient（凭证缺失会抛 std::runtime_error）
    RealBackends(const AppConfig& cfg, Engine* engine, LogFn log, bool no_servo = false);

    void setEngine(Engine* engine) { engine_ = engine; }

    void submit_ocr(int pid, const cv::Mat& frame, const cv::Rect& box) override;
    void submit_llm(int pid, const std::string& province) override;
    void submit_servo(int pid, const std::string& servo_id) override;

    int active_jobs() const { return active_.load(); }
    int ocr_llm_jobs() const { return ocr_llm_active_.load(); }
    // 等待后台任务全部结束（毫秒），返回是否已空闲
    bool wait_idle(int timeout_ms);

private:
    void spawn_job(std::function<void()> job);
    void spawn_ocr_llm_job(std::function<void()> job);

    AppConfig cfg_;
    Engine* engine_ = nullptr;
    LogFn log_;
    bool no_servo_ = false;
    OcrClient ocr_;
    LlmClient llm_;
    std::atomic<int> active_{0};
    std::atomic<int> ocr_llm_active_{0};   // 仅统计 OCR/LLM（不含舵机），用于动态帧率
    std::mutex llm_cache_mu_;
    std::map<std::string, std::string> llm_cache_;   // 省份 -> shipping JSON（同省直接复用）
};

// 干跑后端：不调用任何外部服务，立即回调（假省份/假分类）。
class FakeBackends : public Backends {
public:
    using LogFn = std::function<void(const std::string&)>;

    FakeBackends(Engine* engine, LogFn log, std::string category = "货运",
                 std::string province = "新疆维吾尔自治区");

    void setEngine(Engine* engine) { engine_ = engine; }

    void submit_ocr(int pid, const cv::Mat& frame, const cv::Rect& box) override;
    void submit_llm(int pid, const std::string& province) override;
    void submit_servo(int pid, const std::string& servo_id) override;

    struct Totals {
        int ocr = 0;
        int llm = 0;
        int servo = 0;
    };
    const Totals& totals() const { return totals_; }

private:
    Engine* engine_ = nullptr;
    LogFn log_;
    std::string category_;
    std::string province_;
    Totals totals_;
};
