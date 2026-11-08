// ocr_client.hpp — 百度智能云 手写文字识别（REST API）客户端
// 移植自 /root/img/parcel_pipeline.cpp 与 Python 版 hw.py 的 BaiduOCR：
//   - access_token 缓存（expires_in - 300s 提前过期）
//   - POST rest/2.0/ocr/v1/handwriting，image=urlencode(base64(jpg)), detect_direction=true
//   - 返回拼接后的文本；任何错误抛出 std::runtime_error（由调用方转 handle_ocr_error）
#pragma once

#include <mutex>
#include <string>
#include <sys/types.h>

struct OcrConfig {
    std::string provider = "baidu";   // "baidu" | "local"
    std::string local_cmd = "/usr/bin/python3 /root/sorter/local_ocr.py {image}";
    std::string endpoint = "https://aip.baidubce.com/rest/2.0/ocr/v1/handwriting";
    std::string credentials_file = "/root/sorter/ocr_credentials.json";
    int timeout_sec = 20;
    int rotate = 0;         // 0 或 180（裁剪后旋转）
    int crop_pad_px = 10;   // 裁剪外扩像素
    std::string tmp_dir = "/tmp";
    std::string capture_dir = "/root/sorter_cpp/captures";   // OCR 截图留档目录
};

class OcrClient {
public:
    // 凭证：优先环境变量 BAIDU_API_KEY / BAIDU_SECRET_KEY，
    // 否则读 credentials_file（JSON: {"api_key": "...", "secret_key": "..."}）。
    // 凭证缺失时构造抛出 std::runtime_error。
    explicit OcrClient(const OcrConfig& cfg);
    ~OcrClient();

    OcrClient(const OcrClient&) = delete;
    OcrClient& operator=(const OcrClient&) = delete;

    // 识别本地图片（jpg/png），返回 words_result 拼接文本（无分隔符，与 Python 版一致）。
    // 失败抛 std::runtime_error。
    std::string recognize(const std::string& image_path);

    // 工具函数（测试可用）
    static std::string base64_encode(const std::string& data);
    static std::string url_encode(const std::string& value);

private:
    std::string get_token();
    std::string run_local(const std::string& image_path);
    void ensure_local_server();
    void stop_local_server();

    OcrConfig cfg_;
    std::string api_key_;
    std::string secret_key_;
    std::mutex mu_;
    std::string token_;
    double token_expire_ = 0.0;  // epoch 秒

    // 本地 OCR 常驻子进程
    std::mutex local_mu_;
    pid_t local_pid_ = -1;
    int local_in_ = -1;
    int local_out_ = -1;
};
