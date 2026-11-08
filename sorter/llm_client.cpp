// llm_client.cpp — 移植自 /root/img/llm_shipping.cpp 的 ask()（独立拷贝）
#include "llm_client.hpp"

#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

namespace {

using json = nlohmann::json;

// 与 llm_shipping.cpp 完全一致（仓库在深圳，按秦岭淮河分界）
const char* SYSTEM_PROMPT =
    "仓库在深圳，按省份选择快递方式："
    "广东省为本地快递；"
    "秦岭淮河以南的南方省份为货运快递；"
    "秦岭淮河以北的北方省份为空运快递。"
    "南方省份：江苏、安徽、浙江、上海、湖北、湖南、江西、福建、广西、海南、重庆、四川、贵州、云南。"
    "北方省份：北京、天津、河北、山西、内蒙古、辽宁、吉林、黑龙江、山东、河南、陕西、甘肃、青海、宁夏、新疆、西藏。"
    "特别注意：天津、河南、宁夏属于北方省份，必须输出空运快递。"
    "只输出JSON对象，格式为{\"shipping\":\"本地快递\"}或{\"shipping\":\"货运快递\"}或{\"shipping\":\"空运快递\"}，不要解释。";

size_t write_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* out = static_cast<std::string*>(userdata);
    out->append(ptr, size * nmemb);
    return size * nmemb;
}

}  // namespace

LlmResult LlmClient::ask(const std::string& province) {
    LlmResult r;
    std::string province_json = json{{"province", province}}.dump();
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
        {"max_tokens", cfg_.max_tokens},
        {"stream", false},
        {"response_format", {{"type", "json_object"}}},
    };
    std::string body_str = body.dump();
    std::string response;

    CURL* curl = curl_easy_init();
    if (!curl) {
        r.error = "curl_easy_init 失败";
        return r;
    }
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_URL, cfg_.url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body_str.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body_str.size()));
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, static_cast<long>(cfg_.curl_timeout_sec > 0 ? cfg_.curl_timeout_sec : 120));
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, static_cast<long>(cfg_.connect_timeout_sec > 0 ? cfg_.connect_timeout_sec : 5));
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

    auto t0 = std::chrono::steady_clock::now();
    CURLcode rc = curl_easy_perform(curl);
    auto t1 = std::chrono::steady_clock::now();
    r.ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    r.http_code = http_code;
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
        r.raw = resp.at("choices").at(0).at("message").at("content").get<std::string>();
    } catch (const std::exception& e) {
        r.error = std::string("parse response: ") + e.what();
        return r;
    }

    try {
        json out = json::parse(r.raw);
        r.shipping = out.at("shipping").get<std::string>();
        r.ok = r.shipping == "本地快递" || r.shipping == "货运快递" || r.shipping == "空运快递";
        if (!r.ok) {
            r.error = "unexpected shipping value";
        }
    } catch (const std::exception& e) {
        r.error = std::string("model output not valid JSON: ") + e.what();
    }
    return r;
}

bool LlmClient::classify(const std::string& province, std::string& shipping, std::string& err) {
    LlmResult r = ask(province);
    if (!r.ok) {
        err = r.error.empty() ? "未知错误" : r.error;
        return false;
    }
    shipping = r.shipping;
    err.clear();
    return true;
}
