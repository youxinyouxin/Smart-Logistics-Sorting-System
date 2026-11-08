// env_ask.cpp — 从本机采集服务 API 拉取环境数据，交给 Qwen 回答
// 编译: g++ -O2 -std=c++17 env_ask.cpp -lcurl -o env_ask
// 用法: ./env_ask "现在环境怎么样"
//       ./env_ask -i         交互模式（每次提问前刷新数据）
//       ./env_ask --api http://192.168.1.100:81/api/data "问题"

#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <chrono>
#include <iostream>
#include <string>

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

static const char* SYSTEM_PROMPT =
    "你是环境监测助手。根据用户消息中的传感器数据回答问题。"
    "用一句简洁的中文回答，只描述数据反映的实际情况，不要复读原始数据格式，不要输出JSON。";

static const char* FEWSHOT_USER = "数据：温度28.5℃，湿度55%RH，CO2=555ppm。问题：现在环境怎么样？";
static const char* FEWSHOT_ASSISTANT = "当前温度 28.5 摄氏度，湿度 55%，CO2 浓度 555ppm，环境比较舒适。";

static size_t write_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* out = static_cast<std::string*>(userdata);
    out->append(ptr, size * nmemb);
    return size * nmemb;
}

static std::string http_get(const std::string& url) {
    std::string out;
    CURL* curl = curl_easy_init();
    if (!curl) return "";
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &out);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 8L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 3L);
    CURLcode rc = curl_easy_perform(curl);
    long code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
    curl_easy_cleanup(curl);
    if (rc != CURLE_OK || code != 200) return "";
    return out;
}

static std::string field_cn(const std::string& src, const std::string& k) {
    if (src == "iot") {
        if (k == "0") return "模拟量A0";
        if (k == "2") return "模拟量A2";
        if (k == "4") return "模拟量A4";
        if (k == "temperature") return "温度(℃)";
        if (k == "illumination") return "光照(lux)";
    } else if (src == "multi_in_one") {
        if (k == "co2") return "CO2(ppm)";
        if (k == "tvoc") return "TVOC(ppb)";
        if (k == "temperature") return "温度(℃)";
        if (k == "humidity") return "湿度(%RH)";
        if (k == "body") return "人体感应";
        if (k == "pm2_5") return "PM2.5(ug/m3)";
        if (k == "pressure_hpa") return "气压(hPa)";
    } else if (src == "louver_box") {
        if (k == "temperature") return "温度(℃)";
        if (k == "humidity") return "湿度(%RH)";
        if (k == "noise") return "噪音(dB)";
        if (k == "illumination") return "光照(lux)";
        if (k == "pm2_5") return "PM2.5(ug/m3)";
        if (k == "pm10") return "PM10(ug/m3)";
        if (k == "pressure") return "气压(kPa)";
    }
    return k;
}

static std::string build_context(const json& data) {
    std::string s;
    for (auto& [src, obj] : data.items()) {
        if (!obj.is_object()) continue;
        if (obj.contains("values") && obj["values"].is_object()) {
            for (auto& [k, v] : obj["values"].items()) {
                if (src == "iot" && (k == "0" || k == "2" || k == "4")) continue;
                if (!s.empty()) s += "，";
                s += field_cn(src, k) + "=";
                if (v.is_boolean()) {
                    s += v.get<bool>() ? "有人" : "无人";
                } else if (v.is_string()) {
                    s += v.get<std::string>();
                } else {
                    s += v.dump();
                }
            }
        }
    }
    if (s.empty()) s = "暂无数据";
    return s;
}

struct Answer {
    bool ok = false;
    std::string text;
    double ms = 0.0;
};

static Answer ask_llm(const std::string& endpoint, const std::string& context, const std::string& question) {
    Answer a;
    json body = {
        {"messages", json::array({
            {{"role", "system"}, {"content", SYSTEM_PROMPT}},
            {{"role", "user"}, {"content", FEWSHOT_USER}},
            {{"role", "assistant"}, {"content", FEWSHOT_ASSISTANT}},
            {{"role", "user"}, {"content", "数据：" + context + "。问题：" + question}},
        })},
        {"temperature", 0.3},
        {"max_tokens", 160},
        {"stream", false},
    };
    std::string body_str = body.dump();
    std::string response;

    CURL* curl = curl_easy_init();
    if (!curl) return a;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_URL, endpoint.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body_str.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)body_str.size());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 180L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 5L);

    auto t0 = Clock::now();
    CURLcode rc = curl_easy_perform(curl);
    auto t1 = Clock::now();
    a.ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (rc != CURLE_OK || http_code != 200) return a;
    try {
        json resp = json::parse(response);
        a.text = resp.at("choices").at(0).at("message").at("content").get<std::string>();
        a.ok = true;
    } catch (...) {
    }
    return a;
}

static void one_round(const std::string& api, const std::string& endpoint, const std::string& question) {
    std::string raw = http_get(api);
    if (raw.empty()) {
        std::cerr << "获取环境数据失败: " << api << "\n";
        return;
    }
    json data;
    try {
        data = json::parse(raw);
    } catch (const std::exception& e) {
        std::cerr << "环境数据不是合法 JSON: " << e.what() << "\n";
        return;
    }
    std::string context = build_context(data);
    Answer a = ask_llm(endpoint, context, question);
    if (!a.ok) {
        std::cerr << "Qwen 回答失败\n";
        return;
    }
    std::cout << a.text << "\n";
    std::cout << "（耗时 " << a.ms << " ms）\n";
}

int main(int argc, char** argv) {
    std::string api = "http://192.168.1.100:81/api/data";
    std::string endpoint = "http://127.0.0.1:8080/v1/chat/completions";
    bool interactive = false;
    std::string question;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--api" && i + 1 < argc) api = argv[++i];
        else if (a == "-i") interactive = true;
        else question = a;
    }

    curl_global_init(CURL_GLOBAL_DEFAULT);

    if (interactive) {
        std::cout << "环境问答模式（数据源 " << api << "，输入 q 退出）\n";
        std::string line;
        while (true) {
            std::cout << "\n> " << std::flush;
            if (!std::getline(std::cin, line)) break;
            if (line == "q" || line == "quit" || line == "exit") break;
            if (line.empty()) continue;
            one_round(api, endpoint, line);
        }
    } else {
        if (question.empty()) {
            question = "现在的环境数据是什么样的？";
        }
        one_round(api, endpoint, question);
    }

    curl_global_cleanup();
    return 0;
}
