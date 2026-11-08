// llm_client.hpp — 本地 llama-server (Qwen2.5-0.5B) 严格枚举分类客户端
// 从 /root/img/llm_shipping.cpp 的 ask() 移植（独立拷贝，不改原文件）：
//   同一 system prompt、同一 few-shot、temperature 0、response_format json_object、
//   max_tokens 32、curl 超时 120s / 连接 5s。
#pragma once

#include <string>

struct LlmConfig {
    std::string url = "http://127.0.0.1:8080/v1/chat/completions";
    int timeout_sec = 30;        // Python 版 subprocess 超时（保留配置项，readback 用）
    int max_tokens = 32;
    int curl_timeout_sec = 120;  // 与 llm_shipping.cpp 一致
    int connect_timeout_sec = 5;
};

struct LlmResult {
    bool ok = false;
    std::string shipping;   // 严格枚举：本地快递 / 货运快递 / 空运快递
    std::string raw;        // 模型原始 content
    std::string error;
    double ms = 0.0;
    long http_code = 0;
};

class LlmClient {
public:
    explicit LlmClient(const LlmConfig& cfg) : cfg_(cfg) {}

    // 严格校验返回值 ∈ {本地快递, 货运快递, 空运快递}；失败时 err 非空。
    bool classify(const std::string& province, std::string& shipping, std::string& err);

    // 完整结果（含耗时/原始输出），供 --classify-test 打印
    LlmResult ask(const std::string& province);

private:
    LlmConfig cfg_;
};
