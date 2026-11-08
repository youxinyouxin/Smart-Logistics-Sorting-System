#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

static long long elapsed_ms(Clock::time_point start) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - start).count();
}

static size_t write_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* out = static_cast<std::string*>(userdata);
    out->append(ptr, size * nmemb);
    return size * nmemb;
}

struct HttpResponse {
    long status = 0;
    std::string body;
};

static HttpResponse http_post(const std::string& url, const std::string& body) {
    HttpResponse resp;
    CURL* curl = curl_easy_init();
    if (!curl) {
        return resp;
    }
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/x-www-form-urlencoded");
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.data());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 120L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    CURLcode rc = curl_easy_perform(curl);
    if (rc == CURLE_OK) {
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &resp.status);
    } else {
        std::cerr << "curl error: " << curl_easy_strerror(rc) << "\n";
    }
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    return resp;
}

static std::string read_file(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

static std::string base64_encode(const std::string& data) {
    static const char* table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((data.size() + 2) / 3 * 4);
    size_t i = 0;
    while (i + 2 < data.size()) {
        unsigned int n = (static_cast<unsigned char>(data[i]) << 16) |
                         (static_cast<unsigned char>(data[i + 1]) << 8) |
                         static_cast<unsigned char>(data[i + 2]);
        out.push_back(table[(n >> 18) & 63]);
        out.push_back(table[(n >> 12) & 63]);
        out.push_back(table[(n >> 6) & 63]);
        out.push_back(table[n & 63]);
        i += 3;
    }
    if (i < data.size()) {
        unsigned int n = static_cast<unsigned char>(data[i]) << 16;
        if (i + 1 < data.size()) {
            n |= static_cast<unsigned char>(data[i + 1]) << 8;
        }
        out.push_back(table[(n >> 18) & 63]);
        out.push_back(table[(n >> 12) & 63]);
        out.push_back(i + 1 < data.size() ? table[(n >> 6) & 63] : '=');
        out.push_back('=');
    }
    return out;
}

static std::string url_encode(const std::string& value) {
    CURL* curl = curl_easy_init();
    if (!curl) {
        return value;
    }
    char* escaped = curl_easy_escape(curl, value.data(), static_cast<int>(value.size()));
    std::string out = escaped ? escaped : "";
    curl_free(escaped);
    curl_easy_cleanup(curl);
    return out;
}

static std::string config_value(const std::string& key, const std::string& fallback = "") {
    const char* env = std::getenv(key.c_str());
    if (env && *env) {
        return env;
    }
    const char* conf_env = std::getenv("BAIDU_OCR_CONF");
    std::string conf = conf_env && *conf_env ? conf_env : "/root/img/.baidu_ocr.conf";
    std::ifstream in(conf);
    std::string line;
    while (std::getline(in, line)) {
        if (line.empty() || line[0] == '#') {
            continue;
        }
        auto pos = line.find('=');
        if (pos == std::string::npos) {
            continue;
        }
        if (line.substr(0, pos) == key) {
            return line.substr(pos + 1);
        }
    }
    return fallback;
}

static void print_words(const json& result) {
    if (!result.contains("words_result")) {
        return;
    }
    for (const auto& item : result["words_result"]) {
        std::cout << item.value("words", "") << "\n";
    }
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: " << argv[0] << " <image> [--runs N] [--out result.json]\n";
        return 2;
    }
    std::string image_path = argv[1];
    int runs = 1;
    std::string out_path;
    for (int i = 2; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--runs" && i + 1 < argc) {
            runs = std::max(1, std::atoi(argv[++i]));
        } else if (arg == "--out" && i + 1 < argc) {
            out_path = argv[++i];
        }
    }

    const std::string api_key = config_value("BAIDU_API_KEY");
    const std::string secret_key = config_value("BAIDU_SECRET_KEY");
    if (api_key.empty() || secret_key.empty()) {
        std::cerr << "missing BAIDU_API_KEY / BAIDU_SECRET_KEY\n";
        return 3;
    }

    auto total_start = Clock::now();
    curl_global_init(CURL_GLOBAL_DEFAULT);

    std::string image = read_file(image_path);
    if (image.empty()) {
        std::cerr << "cannot read image: " << image_path << "\n";
        return 4;
    }

    auto token_start = Clock::now();
    std::string token_body = "grant_type=client_credentials&client_id=" + api_key +
                             "&client_secret=" + secret_key;
    HttpResponse token_resp = http_post("https://aip.baidubce.com/oauth/2.0/token", token_body);
    long long token_ms = elapsed_ms(token_start);

    std::string access_token;
    try {
        json token_json = json::parse(token_resp.body);
        if (token_json.contains("access_token")) {
            access_token = token_json["access_token"].get<std::string>();
        } else {
            std::cerr << "token error: " << token_resp.body << "\n";
            return 5;
        }
    } catch (const std::exception& e) {
        std::cerr << "token parse error: " << e.what() << "\n" << token_resp.body << "\n";
        return 5;
    }

    auto encode_start = Clock::now();
    std::string base64 = base64_encode(image);
    std::string escaped = url_encode(base64);
    long long encode_ms = elapsed_ms(encode_start);

    std::string url = "https://aip.baidubce.com/rest/2.0/ocr/v1/handwriting?access_token=" + access_token;
    std::string form = "image=" + escaped +
                       "&language_type=CHN_ENG&detect_direction=true&probability=true";

    std::cout << "image: " << image_path << " (" << image.size() << " bytes, base64 "
              << base64.size() << " bytes)\n";
    std::cout << "token_ms: " << token_ms << "\n";
    std::cout << "encode_ms: " << encode_ms << "\n";

    std::string last_body;
    for (int i = 1; i <= runs; ++i) {
        auto ocr_start = Clock::now();
        HttpResponse resp = http_post(url, form);
        long long ocr_ms = elapsed_ms(ocr_start);
        last_body = resp.body;
        std::cout << "ocr_run " << i << ": http=" << ocr_ms << "ms status=" << resp.status << "\n";
        try {
            json result = json::parse(resp.body);
            if (result.contains("error_code")) {
                std::cout << "error: " << result["error_code"] << " " << result.value("error_msg", "") << "\n";
            } else {
                int count = result.value("words_result_num", 0);
                std::cout << "words_result_num: " << count << "\n";
                print_words(result);
            }
        } catch (const std::exception& e) {
            std::cout << "parse error: " << e.what() << "\n" << resp.body << "\n";
        }
    }

    if (!out_path.empty()) {
        std::ofstream out(out_path, std::ios::binary);
        out << last_body;
    }
    std::cout << "total_ms: " << elapsed_ms(total_start) << "\n";
    curl_global_cleanup();
    return 0;
}
