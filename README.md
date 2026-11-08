# Smart Logistics Sorting System（K1 板）

基于 SpacemiT K1（RISC-V 64 / Bianbu）的传送带快递自动分拣系统 + 工厂环境 AI 助手。

## 项目组成

| 目录 | 内容 |
|------|------|
| `sorter/` | 分拣主程序（C++17）：OpenCV 检测 + RapidOCR 本地 OCR + Qwen 本地分类 + 舵机/传送带控制 |
| `sorter/llm/run_llm_server.sh` | llama-server 启动脚本（Qwen2.5-0.5B, 127.0.0.1:8080） |
| `sorter/models/ocr/` | PP-OCRv4 ONNX 模型（检测/识别/方向分类） |
| `py/` | 板端采集 API（FastAPI）：IoT Modbus 采集、DO 继电器控制、RFID |
| `QA/` | AI 助手（Qwen3-8B 云端 + 百度 ASR/TTS + function calling 工具） |
| `servo/` | 舵机 PWM 驱动（硬件 PWM + 软件 50Hz） |
| `Web/CloudPlatform/` | 工厂数据前端（Vite） |
| `img/` | 早期摄像头 OCR / LLM 客户端（C++ 示例） |
| `PROJECT_SUMMARY.md` | 分拣系统详细设计与运行总结 |

## 硬件

- 主控：SpacemiT K1 MUSE-Pi-Pro（8×X60, riscv64, RVV 1.0, 15GB RAM, Bianbu 2.3.5, 内核 6.6.63）
- 摄像头：USB UVC（`/dev/video20`, MJPG 1280×720）
- 舵机 ×2：GPIO34（硬件 PWM）/ GPIO71（软件 50Hz）
- 传送带：GPIO70（active-low）
- 音频：USB 麦克风（PCM2902）+ 板载 ES8326 播放
- 采集器：Modbus TCP（温度/光照/CO2/TVOC/PM2.5/人体/气压），API 端口 81

## 快速部署（板端）

### 1. 系统依赖

```bash
sudo apt update
sudo apt install -y build-essential gcc-14 g++-14 cmake libcurl4-openssl-dev \
  nlohmann-json3-dev libopencv-dev python3-pip ffmpeg alsa-utils
# GPIO 驱动（按系统提供）
sudo apt install -y liblgpio-dev  # 或源码编译 lgpio
```

### 2. 编译分拣主程序

```bash
cd sorter
make            # 生成 sorter / servo_pwm / test_engine
./test_engine   # 引擎自测（60 项断言）
```

### 3. llama.cpp + 模型（本地 LLM）

```bash
# 源码（二选一）
tar xzf llama.cpp-master.tar.gz            # 本仓库附带
# git clone https://github.com/ggml-org/llama.cpp

cd llama.cpp-master    # 或 llama.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER=gcc-14 -DCMAKE_CXX_COMPILER=g++-14 -DLLAMA_CURL=OFF
cmake --build build -j8 --target llama-server llama-cli

# 模型（已通过 Git LFS 纳入仓库，clone 后自动在 sorter/llm/ 下）
# 如需手动下载：
wget -O sorter/llm/qwen2.5-0.5b-instruct-q4_k_m.gguf \
  https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf

bash sorter/llm/run_llm_server.sh   # 启动 127.0.0.1:8080
```

注意：
- **必须用 GCC 14**：GCC 13 的 `riscv_vector.h` 缺少 fp16 向量 intrinsic（`vfloat16m2_t`），编译 `ggml-cpu` 会失败。
- 曾尝试 SpacemiT IME（`-DGGML_CPU_RISCV64_SPACEMIT=ON`），实测比纯 RVV 更慢（prefill 11 vs 20 tok/s），且缺 `/dev/tcm_sync_mem` 时 8 线程会崩溃，故未采用。
- Q4_K_M 是生产量化；Q4_0 虽快 4.5 倍但 0.5B 准确率骤降，勿用。

### 4. Python 依赖

```bash
pip3 install requests numpy fastapi uvicorn pyyaml pyserial
# 分拣本地 OCR（如用 local_ocr_server.py）
pip3 install rapidocr_onnxruntime numpy pyclipper shapely
```

### 5. 配置

```bash
# 板端采集 API
vi py/config.yaml                  # 采集器 Modbus IP / 端口

# AI 助手密钥（不要提交真实密钥）
cp QA/qa.conf.example QA/qa.conf
chmod 600 QA/qa.conf
vi QA/qa.conf                      # 填 SILICONFLOW / BAIDU 密钥
```

### 6. 启动

```bash
# 采集 API（本机/板端）
cd py && python3 api_server.py

# 分拣（需摄像头、舵机、传送带就绪）
cd sorter && ./sorter

# AI 助手（语音唤醒"小新同学"）
cd QA && python3 voice_chat.py
# 或文字问答
python3 QA/agent_chat.py --speak "现在环境怎么样"
```

## AI 助手（QA/）

- 模型：Qwen3-8B（硅基流动，OpenAI 兼容，`enable_thinking: false`）
- 工具（function calling）：`get_env_data` / `get_do_status` / `set_do` / `get_today_count`
- 语音：百度短语音识别（VAD 断句）+ 百度短语音合成
- 唤醒词：小新同学（容错：小欣/小兴/小星/小辛同学）
- 行为：控制命令本地确认秒回；云端限流/超时自动走本地模板兜底；环境回答不含人体感应

## 已知限制

1. 舵机 1 抖动（GPIO34 硬件 PWM 最高约 195Hz，无法 50Hz），排查中。
2. 本地 OCR 首次加载模型 10–18 秒，之后 2–4 秒/张。
3. Qwen2.5-0.5B 省份分类准确率约 90%（天津、宁夏易错）。
4. 硅基流动免费档有 TPM 限流，助手已内置重试 + 本地兜底。
5. 大文件：GGUF 模型通过 **Git LFS** 提供（clone 前请先 `git lfs install`）；node_modules、构建产物、运行日志、截图不在仓库内。

## 安全

- 所有密钥使用模板文件（`QA/qa.conf.example`），真实 `qa.conf` 不入库。
- 百度 OCR 凭证文件（`ocr_credentials.json`）按需单独放置，不入库。

## 参考

详细的分拣流程、参数、目录和运行状态见 [PROJECT_SUMMARY.md](PROJECT_SUMMARY.md)。
