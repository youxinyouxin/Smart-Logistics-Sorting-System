#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <opencv2/opencv.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

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

static std::string config_value(const std::string& key) {
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
    return "";
}

struct Candidate {
    std::vector<cv::Point> contour;
    cv::Rect bbox;
    double areaFrac = 0.0;
    double fill = 0.0;
    double whiteFrac = 0.0;
    double score = 0.0;
};

static bool findParcel(const cv::Mat& bgr, Candidate& best) {
    cv::Mat hsv;
    cv::cvtColor(bgr, hsv, cv::COLOR_BGR2HSV);
    cv::Mat mask;
    cv::inRange(hsv, cv::Scalar(5, 35, 30), cv::Scalar(35, 255, 255), mask);
    cv::Mat kernel = cv::getStructuringElement(cv::MORPH_RECT, cv::Size(7, 7));
    cv::morphologyEx(mask, mask, cv::MORPH_CLOSE, kernel, cv::Point(-1, -1), 2);
    cv::morphologyEx(mask, mask, cv::MORPH_OPEN, kernel, cv::Point(-1, -1), 1);

    std::vector<std::vector<cv::Point>> contours;
    cv::findContours(mask, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);
    const double imgArea = static_cast<double>(bgr.rows) * bgr.cols;
    const double diag = std::sqrt(static_cast<double>(bgr.rows) * bgr.rows +
                                  static_cast<double>(bgr.cols) * bgr.cols);
    bool found = false;
    double bestScore = -1e9;

    for (const auto& contour : contours) {
        double area = cv::contourArea(contour);
        double areaFrac = area / imgArea;
        if (areaFrac < 0.005 || areaFrac > 0.30) {
            continue;
        }
        cv::Rect bbox = cv::boundingRect(contour);
        if (bbox.width < 60 || bbox.height < 50) {
            continue;
        }
        double fill = area / static_cast<double>(bbox.area());
        if (fill < 0.45) {
            continue;
        }
        cv::Rect roi = bbox & cv::Rect(0, 0, bgr.cols, bgr.rows);
        cv::Mat hsvRoi = hsv(roi);
        cv::Mat white;
        cv::inRange(hsvRoi, cv::Scalar(0, 0, 150), cv::Scalar(180, 55, 255), white);
        double whiteFrac = static_cast<double>(cv::countNonZero(white)) / roi.area();
        double cx = bbox.x + bbox.width / 2.0;
        double cy = bbox.y + bbox.height / 2.0;
        double centerDist = std::sqrt(std::pow(cx - bgr.cols / 2.0, 2) +
                                      std::pow(cy - bgr.rows / 2.0, 2)) / diag;
        double sizeScore = 1.0 - std::min(1.0, std::abs(areaFrac - 0.08) / 0.08);
        double score = whiteFrac * 4.0 + fill * 0.5 + sizeScore * 0.8 - centerDist * 0.8;
        if (score > bestScore) {
            bestScore = score;
            best = Candidate{contour, bbox, areaFrac, fill, whiteFrac, score};
            found = true;
        }
    }
    if (found) {
        std::cout << "candidate: area=" << best.areaFrac << " fill=" << best.fill
                  << " white=" << best.whiteFrac << " score=" << best.score
                  << " bbox=" << best.bbox << "\n";
    }
    return found;
}

static std::string ocr_image(const std::string& jpg_path, long long& token_ms,
                             long long& encode_ms, long long& ocr_ms, json& response) {
    std::string api_key = config_value("BAIDU_API_KEY");
    std::string secret_key = config_value("BAIDU_SECRET_KEY");
    if (api_key.empty() || secret_key.empty()) {
        std::cerr << "missing BAIDU_API_KEY / BAIDU_SECRET_KEY\n";
        return "";
    }
    auto token_start = Clock::now();
    std::string token_body = "grant_type=client_credentials&client_id=" + api_key +
                             "&client_secret=" + secret_key;
    HttpResponse token_resp = http_post("https://aip.baidubce.com/oauth/2.0/token", token_body);
    token_ms = elapsed_ms(token_start);
    std::string access_token;
    try {
        json j = json::parse(token_resp.body);
        if (!j.contains("access_token")) {
            std::cerr << "token error: " << token_resp.body << "\n";
            return "";
        }
        access_token = j["access_token"].get<std::string>();
    } catch (const std::exception& e) {
        std::cerr << "token parse error: " << e.what() << "\n";
        return "";
    }

    auto encode_start = Clock::now();
    std::string image = read_file(jpg_path);
    std::string base64 = base64_encode(image);
    std::string escaped = url_encode(base64);
    encode_ms = elapsed_ms(encode_start);

    std::string url = "https://aip.baidubce.com/rest/2.0/ocr/v1/handwriting?access_token=" + access_token;
    std::string form = "image=" + escaped +
                       "&language_type=CHN_ENG&detect_direction=true&probability=true";
    auto ocr_start = Clock::now();
    HttpResponse resp = http_post(url, form);
    ocr_ms = elapsed_ms(ocr_start);

    std::string text;
    try {
        response = json::parse(resp.body);
        if (response.contains("error_code")) {
            std::cerr << "ocr error: " << response["error_code"] << " "
                      << response.value("error_msg", "") << "\n";
            return "";
        }
        for (const auto& item : response["words_result"]) {
            text += item.value("words", "") + "\n";
        }
    } catch (const std::exception& e) {
        std::cerr << "ocr parse error: " << e.what() << "\n" << resp.body << "\n";
    }
    return text;
}

int main(int argc, char** argv) {
    std::string image_path;
    bool use_camera = false;
    bool do_ocr = true;
    std::string outdir = "/root/img/captures";
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--image" && i + 1 < argc) {
            image_path = argv[++i];
        } else if (arg == "--camera") {
            use_camera = true;
        } else if (arg == "--no-ocr") {
            do_ocr = false;
        } else if (arg == "--outdir" && i + 1 < argc) {
            outdir = argv[++i];
        }
    }
    if (!use_camera && image_path.empty()) {
        std::cerr << "usage: " << argv[0] << " --camera | --image <path> [--no-ocr] [--outdir DIR]\n";
        return 2;
    }

    curl_global_init(CURL_GLOBAL_DEFAULT);
    auto total_start = Clock::now();
    cv::Mat frame;

    if (use_camera) {
        cv::VideoCapture cap(20, cv::CAP_V4L2);
        cap.set(cv::CAP_PROP_FOURCC, cv::VideoWriter::fourcc('M', 'J', 'P', 'G'));
        cap.set(cv::CAP_PROP_FRAME_WIDTH, 1280);
        cap.set(cv::CAP_PROP_FRAME_HEIGHT, 720);
        cap.set(cv::CAP_PROP_BUFFERSIZE, 1);
        if (!cap.isOpened()) {
            std::cerr << "cannot open camera /dev/video20\n";
            return 3;
        }
        for (int i = 0; i < 10; ++i) {
            cap.grab();
        }
        cap.read(frame);
        cap.release();
        if (frame.empty()) {
            std::cerr << "empty camera frame\n";
            return 3;
        }
    } else {
        frame = cv::imread(image_path, cv::IMREAD_COLOR);
        if (frame.empty()) {
            std::cerr << "cannot read image: " << image_path << "\n";
            return 3;
        }
    }
    long long capture_ms = elapsed_ms(total_start);
    std::cout << "capture_ms: " << capture_ms << " frame=" << frame.cols << "x" << frame.rows << "\n";

    cv::imwrite(outdir + "/parcel_raw.jpg", frame, {cv::IMWRITE_JPEG_QUALITY, 92});

    auto detect_start = Clock::now();
    Candidate best;
    bool found = findParcel(frame, best);
    long long detect_ms = elapsed_ms(detect_start);
    std::cout << "detect_ms: " << detect_ms << " found=" << (found ? "yes" : "no") << "\n";

    cv::Mat boxed = frame.clone();
    std::string crop_path;
    if (found) {
        std::vector<std::vector<cv::Point>> drawContours{best.contour};
        cv::drawContours(boxed, drawContours, -1, cv::Scalar(0, 0, 255), 3);
        cv::rectangle(boxed, best.bbox, cv::Scalar(0, 0, 255), 3);
        cv::putText(boxed, "parcel", cv::Point(best.bbox.x, std::max(20, best.bbox.y - 10)),
                    cv::FONT_HERSHEY_SIMPLEX, 0.8, cv::Scalar(0, 0, 255), 2);

        auto crop_start = Clock::now();
        int mx = static_cast<int>(best.bbox.width * 0.05);
        int my = static_cast<int>(best.bbox.height * 0.05);
        cv::Rect cropRect(best.bbox.x - mx, best.bbox.y - my,
                          best.bbox.width + 2 * mx, best.bbox.height + 2 * my);
        cropRect = cropRect & cv::Rect(0, 0, frame.cols, frame.rows);
        cv::Mat crop = frame(cropRect).clone();
        double scale = std::max(1.0, 480.0 / std::min(crop.cols, crop.rows));
        if (scale > 1.0) {
            cv::resize(crop, crop, cv::Size(), scale, scale, cv::INTER_CUBIC);
        }
        crop_path = outdir + "/parcel_crop.jpg";
        cv::imwrite(crop_path, crop, {cv::IMWRITE_JPEG_QUALITY, 92});
        long long crop_ms = elapsed_ms(crop_start);
        std::cout << "crop_ms: " << crop_ms << " crop=" << crop.cols << "x" << crop.rows
                  << " " << crop_path << "\n";
    }
    cv::imwrite(outdir + "/parcel_boxed.jpg", boxed, {cv::IMWRITE_JPEG_QUALITY, 92});

    if (found && do_ocr) {
        long long token_ms = 0, encode_ms = 0, ocr_ms = 0;
        json response;
        std::string text = ocr_image(crop_path, token_ms, encode_ms, ocr_ms, response);
        std::cout << "token_ms: " << token_ms << "\n";
        std::cout << "encode_ms: " << encode_ms << "\n";
        std::cout << "ocr_ms: " << ocr_ms << "\n";
        std::cout << "text: " << text;
        std::ofstream out(outdir + "/parcel_ocr.json", std::ios::binary);
        out << response.dump(2);
    }

    std::cout << "total_ms: " << elapsed_ms(total_start) << "\n";
    return found ? 0 : 4;
}
