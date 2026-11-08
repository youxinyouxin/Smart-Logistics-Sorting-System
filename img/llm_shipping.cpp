// llm_shipping.cpp — 调用本地 llama-server (Qwen2.5-0.5B) 输出快递方式 JSON
// 编译: g++ -O2 -std=c++17 llm_shipping.cpp -lcurl -o llm_shipping
// 用法: ./llm_shipping '{"province":"浙江省"}'
//       echo '{"province":"河北省"}' | ./llm_shipping
// 可选: --runs N  重复 N 次并报告每次耗时

#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

static const char* SYSTEM_PROMPT =
    "仓库在深圳，按省份选择快递方式："
    "广东省为本地快递；"
    "秦岭淮河以南的南方省份为货运快递；"
    "秦岭淮河以北的北方省份为空运快递。"
    "南方省份：江苏、安徽、浙江、上海、湖北、湖南、江西、福建、广西、海南、重庆、四川、贵州、云南。"
    "北方省份：北京、天津、河北、山西、内蒙古、辽宁、吉林、黑龙江、山东、河南、陕西、甘肃、青海、宁夏、新疆、西藏。"
    "特别注意：天津、河南、宁夏属于北方省份，必须输出空运快递。"
    "只输出JSON对象，格式为{\"shipping\":\"本地快递\"}或{\"shipping\":\"货运快递\"}或{\"shipping\":\"空运快递\"}，不要解释。";

static size_t write_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* out = static_cast<std::string*>(userdata);
    out->append(ptr, size * nmemb);
    return size * nmemb;
}

struct Result {
    bool ok = false;
    std::string shipping;
    std::string raw_content;
    double ms = 0.0;
    double prompt_ms = 0.0;
    double predicted_ms = 0.0;
    int prompt_n = 0;
    int predicted_n = 0;
    std::string error;
};

static Result ask(const std::string& endpoint, const std::string& province_json, int max_tokens) {
    Result r;
    json messages = json::array({
        {{"role", "system"}, {"content", SYSTEM_PROMPT}},
        {{"role", "user"}, {"content", "{\"province\":\"广东省\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"本地快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"浙江省\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"货运快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"河北省\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"空运快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"上海市\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"货运快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"北京市\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"空运快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"江苏省\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"货运快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"黑龙江省\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"空运快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"海南省\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"货运快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"新疆\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"空运快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"福建省\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"货运快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"陕西省\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"空运快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"广西\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"货运快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"内蒙古\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"空运快递\"}"}},
        {{"role", "user"}, {"content", "{\"province\":\"重庆市\"}"}},
        {{"role", "assistant"}, {"content", "{\"shipping\":\"货运快递\"}"}},
        {{"role", "user"}, {"content", province_json}},
    });
    json body = {
        {"messages", messages},
        {"temperature", 0.0},
        {"max_tokens", max_tokens},
        {"stream", false},
        {"response_format", {{"type", "json_object"}}},
    };
    std::string body_str = body.dump();
    std::string response;

    CURL* curl = curl_easy_init();
    if (!curl) {
        r.error = "curl_easy_init failed";
        return r;
    }
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_URL, endpoint.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body_str.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)body_str.size());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 120L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 5L);

    auto t0 = Clock::now();
    CURLcode rc = curl_easy_perform(curl);
    auto t1 = Clock::now();
    r.ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (rc != CURLE_OK) {
        r.error = std::string("curl: ") + curl_easy_strerror(rc);
        return r;
    }
    if (http_code != 200) {
        r.error = "HTTP " + std::to_string(http_code) + ": " + response.substr(0, 300);
        return r;
    }

    try {
        json resp = json::parse(response);
        r.raw_content = resp.at("choices").at(0).at("message").at("content").get<std::string>();
        if (resp.contains("timings")) {
            const auto& t = resp["timings"];
            r.prompt_ms = t.value("prompt_ms", 0.0);
            r.predicted_ms = t.value("predicted_ms", 0.0);
            r.prompt_n = t.value("prompt_n", 0);
            r.predicted_n = t.value("predicted_n", 0);
        }
    } catch (const std::exception& e) {
        r.error = std::string("parse response: ") + e.what();
        return r;
    }

    try {
        json out = json::parse(r.raw_content);
        r.shipping = out.at("shipping").get<std::string>();
        r.ok = r.shipping == "本地快递" || r.shipping == "货运快递" || r.shipping == "空运快递";
        if (!r.ok) r.error = "unexpected shipping value";
    } catch (const std::exception& e) {
        r.error = std::string("model output not valid JSON: ") + e.what();
    }
    return r;
}

int main(int argc, char** argv) {
    std::string endpoint = "http://127.0.0.1:8080/v1/chat/completions";
    std::string input;
    int runs = 1;
    int max_tokens = 32;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--url" && i + 1 < argc) endpoint = argv[++i];
        else if (a == "--runs" && i + 1 < argc) runs = std::max(1, std::atoi(argv[++i]));
        else if (a == "--max-tokens" && i + 1 < argc) max_tokens = std::atoi(argv[++i]);
        else input = a;
    }
    if (input.empty()) {
        std::ostringstream ss;
        ss << std::cin.rdbuf();
        input = ss.str();
    }
    while (!input.empty() && (input.back() == '\n' || input.back() == '\r')) input.pop_back();
    if (input.empty()) {
        std::cerr << "用法: " << argv[0] << " '{\"province\":\"浙江省\"}' [--runs N]\n";
        return 1;
    }

    // 校验输入必须是含 province 字段的 JSON
    try {
        json in = json::parse(input);
        if (!in.contains("province") || !in["province"].is_string()) {
            std::cerr << "输入 JSON 必须包含字符串字段 province\n";
            return 1;
        }
    } catch (const std::exception& e) {
        std::cerr << "输入不是合法 JSON: " << e.what() << "\n";
        return 1;
    }

    curl_global_init(CURL_GLOBAL_DEFAULT);
    std::vector<double> times;
    double total = 0;
    for (int i = 0; i < runs; ++i) {
        Result r = ask(endpoint, input, max_tokens);
        total += r.ms;
        times.push_back(r.ms);
        if (!r.ok) {
            std::cerr << "第 " << i + 1 << " 次失败 (" << r.ms << " ms): " << r.error << "\n";
            if (!r.raw_content.empty()) std::cerr << "  原始输出: " << r.raw_content << "\n";
            curl_global_cleanup();
            return 2;
        }
        std::cout << "第 " << i + 1 << " 次: " << r.ms << " ms  (prefill " << r.prompt_n << " tok/"
                  << r.prompt_ms << " ms = " << (r.prompt_ms > 0 ? r.prompt_n * 1000.0 / r.prompt_ms : 0)
                  << " tok/s, 生成 " << r.predicted_n << " tok/" << r.predicted_ms << " ms = "
                  << (r.predicted_ms > 0 ? r.predicted_n * 1000.0 / r.predicted_ms : 0) << " tok/s)  ->  "
                  << r.raw_content << "\n";
    }
    double avg = total / runs;
    std::cout << "平均: " << avg << " ms  (共 " << runs << " 次)\n";
    std::cout << "RESULT " << json{{"input", json::parse(input)},
                                   {"elapsed_ms", avg}}.dump() << "\n";
    curl_global_cleanup();
    return 0;
}
