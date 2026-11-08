// ocr_client.cpp — 百度手写 OCR 实现（token 缓存 + handwriting REST 调用）
#include "ocr_client.hpp"

#include <curl/curl.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace {

using json = nlohmann::json;

size_t write_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* out = static_cast<std::string*>(userdata);
    out->append(ptr, size * nmemb);
    return size * nmemb;
}

std::string truncate_str(const std::string& s, size_t n) {
    return s.size() <= n ? s : s.substr(0, n) + "...";
}

struct HttpResponse {
    bool transport_ok = false;  // curl 层是否成功
    long status = 0;            // HTTP 状态码
    std::string body;
    std::string error;          // curl 错误文本
};

// form-urlencoded POST。body 可为空字符串（token 请求无 body）。
HttpResponse http_post(const std::string& url, const std::string& body, int timeout_sec) {
    HttpResponse resp;
    CURL* curl = curl_easy_init();
    if (!curl) {
        resp.error = "curl_easy_init 失败";
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
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 5L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, static_cast<long>(timeout_sec > 0 ? timeout_sec : 20));
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    CURLcode rc = curl_easy_perform(curl);
    if (rc == CURLE_OK) {
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &resp.status);
        resp.transport_ok = true;
    } else {
        resp.error = curl_easy_strerror(rc);
    }
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    return resp;
}

std::string read_binary(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        throw std::runtime_error("无法读取图片: " + path);
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

double now_epoch_sec() {
    return std::chrono::duration<double>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

}  // namespace

std::string OcrClient::base64_encode(const std::string& data) {
    static const char* table =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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

std::string OcrClient::url_encode(const std::string& value) {
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

OcrClient::OcrClient(const OcrConfig& cfg) : cfg_(cfg) {
    if (cfg_.provider == "local") {
        return;   // 本地 OCR 模式无需云端凭证
    }
    const char* ak = std::getenv("BAIDU_API_KEY");
    const char* sk = std::getenv("BAIDU_SECRET_KEY");
    if (ak && *ak) {
        api_key_ = ak;
    }
    if (sk && *sk) {
        secret_key_ = sk;
    }
    if ((api_key_.empty() || secret_key_.empty()) && !cfg_.credentials_file.empty()) {
        std::ifstream in(cfg_.credentials_file, std::ios::binary);
        if (in) {
            try {
                json j;
                in >> j;
                if (api_key_.empty()) {
                    api_key_ = j.value("api_key", "");
                }
                if (secret_key_.empty()) {
                    secret_key_ = j.value("secret_key", "");
                }
            } catch (const std::exception&) {
                // 文件存在但不是合法 JSON：按缺失处理，下面统一报错
            }
        }
    }
    if (api_key_.empty() || secret_key_.empty()) {
        throw std::runtime_error(
            "缺少百度 OCR 凭证（BAIDU_API_KEY/BAIDU_SECRET_KEY 或 credentials_file）");
    }
}

std::string OcrClient::get_token() {
    std::lock_guard<std::mutex> lk(mu_);
    double now = now_epoch_sec();
    if (!token_.empty() && now < token_expire_) {
        return token_;
    }
    std::string body = "grant_type=client_credentials&client_id=" + url_encode(api_key_) +
                       "&client_secret=" + url_encode(secret_key_);
    HttpResponse resp = http_post("https://aip.baidubce.com/oauth/2.0/token", body, cfg_.timeout_sec);
    if (!resp.transport_ok) {
        throw std::runtime_error("获取 access_token 失败: " + resp.error);
    }
    json j;
    try {
        j = json::parse(resp.body);
    } catch (const std::exception&) {
        throw std::runtime_error("获取 access_token 失败（响应非 JSON）: " +
                                 truncate_str(resp.body, 200));
    }
    std::string token = j.value("access_token", "");
    if (token.empty()) {
        throw std::runtime_error("获取 access_token 失败: " + truncate_str(resp.body, 300));
    }
    long long expires_in = j.value("expires_in", 2592000LL);
    token_ = token;
    token_expire_ = now + static_cast<double>(expires_in) - 300.0;  // 与 Python 版一致提前 300s
    return token_;
}

std::string OcrClient::recognize(const std::string& image_path) {
    if (cfg_.provider == "local") {
        return run_local(image_path);
    }
    std::string image = read_binary(image_path);
    if (image.empty()) {
        throw std::runtime_error("图片为空: " + image_path);
    }
    std::string token = get_token();
    std::string form = "image=" + url_encode(base64_encode(image)) + "&detect_direction=true";
    std::string url = cfg_.endpoint + "?access_token=" + url_encode(token);
    HttpResponse resp = http_post(url, form, cfg_.timeout_sec);
    if (!resp.transport_ok) {
        throw std::runtime_error("OCR 请求失败: " + resp.error);
    }
    if (resp.status != 200) {
        throw std::runtime_error("OCR HTTP " + std::to_string(resp.status) + ": " +
                                 truncate_str(resp.body, 300));
    }
    json j;
    try {
        j = json::parse(resp.body);
    } catch (const std::exception&) {
        throw std::runtime_error("OCR 响应非 JSON: " + truncate_str(resp.body, 200));
    }
    if (j.contains("error_code")) {
        throw std::runtime_error("OCR 接口错误 " + j.value("error_code", json(0)).dump() + ": " +
                                 j.value("error_msg", ""));
    }
    std::string text;
    if (j.contains("words_result") && j["words_result"].is_array()) {
        for (const auto& item : j["words_result"]) {
            text += item.value("words", "");
        }
    }
    return text;
}

// 本地 OCR：优先常驻子进程（模型只加载一次）；命令含 {image} 时退化为一次性执行
std::string OcrClient::run_local(const std::string& image_path) {
    std::lock_guard<std::mutex> lk(local_mu_);
    if (cfg_.local_cmd.find("{image}") != std::string::npos) {
        std::string cmd = cfg_.local_cmd;
        size_t pos = 0;
        while ((pos = cmd.find("{image}", pos)) != std::string::npos) {
            cmd.replace(pos, 7, image_path);
            pos += image_path.size();
        }
        cmd += " 2>&1";
        FILE* fp = popen(cmd.c_str(), "r");
        if (!fp) {
            throw std::runtime_error("本地 OCR 启动失败: " + cmd);
        }
        std::string out;
        char buf[512];
        while (std::fgets(buf, sizeof(buf), fp)) {
            out += buf;
        }
        const int rc = pclose(fp);
        if (rc != 0) {
            throw std::runtime_error("本地 OCR 失败 rc=" + std::to_string(rc) + ": " +
                                     truncate_str(out, 200));
        }
        while (!out.empty() && (out.back() == '\n' || out.back() == '\r' || out.back() == ' ')) {
            out.pop_back();
        }
        return out;
    }

    // 常驻模式：发路径，读一行文本
    for (int attempt = 0; attempt < 2; ++attempt) {
        ensure_local_server();
        std::string line = image_path + "\n";
        if (write(local_in_, line.data(), line.size()) < 0) {
            stop_local_server();
            continue;
        }
        std::string out;
        for (;;) {
            struct pollfd pfd;
            pfd.fd = local_out_;
            pfd.events = POLLIN;
            pfd.revents = 0;
            int pr = poll(&pfd, 1, cfg_.timeout_sec * 1000);
            if (pr <= 0) {
                stop_local_server();
                throw std::runtime_error("本地 OCR 超时（" + std::to_string(cfg_.timeout_sec) +
                                         "s）");
            }
            char buf[256];
            const ssize_t n = read(local_out_, buf, sizeof(buf));
            if (n <= 0) {
                stop_local_server();
                break;   // 服务退出：外层 attempt 重启一次
            }
            out.append(buf, static_cast<size_t>(n));
            if (out.find('\n') != std::string::npos) {
                while (!out.empty() &&
                       (out.back() == '\n' || out.back() == '\r' || out.back() == ' ')) {
                    out.pop_back();
                }
                return out;
            }
        }
    }
    throw std::runtime_error("本地 OCR 服务不可用");
}

void OcrClient::ensure_local_server() {
    if (local_pid_ > 0) {
        int st = 0;
        if (waitpid(local_pid_, &st, WNOHANG) == 0) {
            return;   // 仍在运行
        }
        stop_local_server();
    }
    int inp[2];
    int outp[2];
    if (pipe(inp) != 0 || pipe(outp) != 0) {
        throw std::runtime_error("本地 OCR 管道创建失败");
    }
    const pid_t pid = fork();
    if (pid < 0) {
        close(inp[0]);
        close(inp[1]);
        close(outp[0]);
        close(outp[1]);
        throw std::runtime_error("本地 OCR fork 失败");
    }
    if (pid == 0) {
        dup2(inp[0], STDIN_FILENO);
        dup2(outp[1], STDOUT_FILENO);
        close(inp[0]);
        close(inp[1]);
        close(outp[0]);
        close(outp[1]);
        execl("/bin/sh", "sh", "-c", cfg_.local_cmd.c_str(), static_cast<char*>(nullptr));
        _exit(127);
    }
    close(inp[0]);
    close(outp[1]);
    local_in_ = inp[1];
    local_out_ = outp[0];
    local_pid_ = pid;
}

void OcrClient::stop_local_server() {
    if (local_pid_ > 0) {
        kill(local_pid_, SIGTERM);
        int st = 0;
        waitpid(local_pid_, &st, 0);
        local_pid_ = -1;
    }
    if (local_in_ >= 0) {
        close(local_in_);
        local_in_ = -1;
    }
    if (local_out_ >= 0) {
        close(local_out_);
        local_out_ = -1;
    }
}

OcrClient::~OcrClient() {
    stop_local_server();
}
