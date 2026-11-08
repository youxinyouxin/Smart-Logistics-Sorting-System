# 传送带快递自动分拣系统 — 项目总结

- 更新日期：2026-11-08
- 当前版本：整合版（`/root/sorter`，主交付目录）
- 板卡地址：192.168.1.102（可能变化，以实际为准）
- HTTP 接口：http://192.168.1.102:82（`sorter-api`，已开机自启）
- 接口文档：`/root/sorter/API.md`；在线调试 http://192.168.1.102:82/docs
- 历史版本：`/root/sorter_cpp2`、`/root/sorter_cpp3` 已冻结；v2 完整备份见 `/root/backups/`

---

## 1. 系统概述

USB 摄像头识别传送带上的快递面单，本地 OCR 提取省份，再由本地 Qwen 模型分类：

| 分类 | 规则 | 执行动作 |
|---|---|---|
| 省内（本地快递） | 仓库在深圳，广东省为本地快递 | 不推箱；传送带启动直到目标离开画面后停机 |
| 货运（货运快递） | 秦岭—淮河以南省份 | 启动传送带；前沿越线触发 1 号舵机推出 |
| 空运（空运快递） | 秦岭—淮河以北省份 | 启动传送带；后沿越线触发 2 号舵机推出 |

关键行为：
- 传送带默认停止；只有“省份识别成功 + LLM 返回合法分类”后才启动。
- 单件串行处理；无快递/流程结束后 GPIO70 高电平停止。
- 省份识别失败：0.5 s 传送带脉冲后重试一次 OCR；第二次仍失败则按配置时长定时清出。
- 分类返回时包裹已越线：不启动传送带，立即触发对应舵机；推完后若未离场再启动传送带清出。
- 省内件：目标从画面消失后再等 `province_lost_stop_sec`（默认 1 s）停带；最长运行 `province_max_run_sec`（默认 20 s）兜底。
- 每件完成后写入 JSON 记录到 `/root/sorter/Record/`。

---

## 2. 硬件清单

| 部件 | 型号 / 参数 | 接线与说明 |
|---|---|---|
| 主控板 | SpacemiT K1 MUSE-Pi-Pro（8×X60，RISC-V 64，RVV） | Bianbu 2.3.5（Ubuntu 24.04 Noble），内核 6.6.63，内存 15 GiB，eMMC 115 GB |
| 摄像头 | USB UVC 摄像头（“USB Camera”） | `/dev/video20`，MJPG 1280×720，设备最高 30 fps；处理帧率自适应 |
| 舵机 1 | 360° 位置舵机 | GPIO34（排针 32 脚），硬件 PWM；位置模式 2200 µs 起始、1200 µs 推出；动作后保持 home 脉冲 |
| 舵机 2 | 普通位置舵机 | GPIO71，50 Hz 软件 PWM；home 2450 µs、swing 1500 µs；动作后由 home 保持进程持续输出脉冲 |
| 传送带电机 | 直流电机 + 驱动 | GPIO70（排针 7 脚），低电平运行、高电平停止（active-low） |
| 显示屏 | 开发板接屏（labwc / Wayland） | 用于 `run_gui.sh` 实时显示窗口 |

### 舵机控制要点

- 舵机 1 硬件 PWM 走 `/sys/class/pwm/pwmchip0/pwm0`，周期 5.12 ms（约 195 Hz，该路上限）。
- 舵机 2 为普通位置舵机，home 已从 2900 µs 降到 2450 µs（2900 超出常见 500–2500 µs 量程，易顶限位）。
- 舵机 2 动作结束后会 fork 一个常驻 home 保持进程，持续输出 50 Hz home 脉冲，避免 GPIO71 悬空导致乱转/掉力；下一次动作会自动结束旧保持进程。释放命令：`/root/sorter/servo_pwm set 2 off`。
- 两路参数均可在 `/root/sorter/servo.yaml` 修改，每次动作重新读取。

---

## 3. 软件环境与工具

| 类别 | 工具 / 版本 |
|---|---|
| 操作系统 | Bianbu 2.3.5（Ubuntu 24.04 Noble），riscv64 |
| 内核 | Linux 6.6.63（SpacemiT K1） |
| 编译器 | g++ 13.2.0（C++17） |
| 计算机视觉 | OpenCV 4.6.0（core / imgproc / videoio / imgcodecs / highgui） |
| HTTP 客户端 | libcurl 8.5.0 |
| JSON | nlohmann/json |
| GPIO | lgpio 0.2.0.0（C）；gpiozero + LGPIOFactory（Python） |
| 脚本运行时 | Python 3.12.3 |
| Web 接口 | FastAPI 0.101.0 + Uvicorn 0.27.1（Pydantic 1.10.14） |
| 模型运行时 | SpacemiT ONNX Runtime 1.24.0 |
| 大模型服务 | llama.cpp 0.8.0-dev（RVV 构建） |
| 进程管理 | systemd |
| 远程运维 | SSH（root 公钥登录） |

### 当前服务状态

| 服务 | 状态 | 说明 |
|---|---|---|
| `sorter-api.service` | active，开机自启 | 记录/日志 HTTP 接口，端口 82 |
| `llama-server.service` | active | 本地 Qwen，127.0.0.1:8080；启动脚本 `/root/sorter/llm/run_llm_server.sh` |
| `log-viewer3.service` | active（历史遗留） | v3 日志页 8898，指向旧目录；当前以 82 端口接口为准 |
| `sorter.service` | inactive | 整合版 systemd 入口，未启用；通常用 `run_gui.sh` 手动运行 |
| `sorter-cpp3.service` | inactive，已禁用 | v3 备份 |
| `sorter-cpp2.service` | inactive，已禁用 | v2 备份 |

---

## 4. 模型与 OCR

### 4.1 大语言模型

- Qwen2.5-0.5B-Instruct，Q4_K_M GGUF（469 MB）
- 模型路径：`/root/sorter/llm/qwen2.5-0.5b-instruct-q4_k_m.gguf`
- 运行时：`/root/sorter/llm/bin/llama-server`（含所需共享库）；启动脚本：`/root/sorter/llm/run_llm_server.sh`
- 服务参数：上下文 1024，8 线程，`http://127.0.0.1:8080/v1/chat/completions`
- 输出严格枚举：`本地快递` / `货运快递` / `空运快递`；省份→分类有缓存

### 4.2 本地 OCR（当前使用）

| 项目 | 内容 |
|---|---|
| 框架 | RapidOCR `rapidocr_onnxruntime 1.4.4` |
| 检测模型 | `ch_PP-OCRv4_det_infer.onnx`（约 4.7 MB） |
| 识别模型 | `ch_PP-OCRv4_rec_infer.onnx`（约 10.8 MB） |
| 方向分类 | `ch_ppocr_mobile_v2.0_cls_infer.onnx`（0°/180°） |
| 模型目录 | `/root/sorter/models/ocr/`（项目自包含副本，约 16 MB；配置使用绝对路径） |
| 后端 | SpacemiT ONNX Runtime 1.24，CPU 8 线程 |
| 配置 | `/root/sorter/rapidocr_config.yaml`（8 线程，`limit_side_len=480`，`model_path` 为绝对路径） |
| 运行方式 | `local_ocr_server.py` 常驻，stdin/stdout 调用；截图存 `/root/sorter/captures/` |

说明：启动后第一次 OCR 需加载模型（约 10–18 秒），之后单张约 2–4 秒。

### 4.3 云端 OCR（保留方案）

- v1/v2 曾使用百度云 handwriting/general/accurate；整合版当前不调用。
- 旧凭证 `ocr_credentials.json` 已随旧目录删除；如需切回云端，重新创建该文件。

---

## 5. 实时显示与自适应帧率

### 显示

- 启动脚本：`/root/sorter/run_gui.sh`（桌面终端执行，自动 sudo 并设置 Wayland/X11 环境）。
- 窗口只显示传送带区域：裁剪 `x=110, y=230, w=1169, h=430`，缩放到 `640×235`。
- 红色矩形框 + 左上角 `P编号`（活动件加粗）；画面左右翻转。
- 关闭窗口或按 `q` 只停止显示，分拣继续；停止分拣需 Ctrl+C / `pkill -INT -x sorter`。
- 当前 `display_fps: 12`；若卡顿可调低到 3–6。

### 处理帧率（自适应）

- OCR/LLM 忙时降到 `fps_low`；结束后升高；每秒采样 CPU，低于阈值用 `fps_high`，高于阈值回落基准 `fps`。
- 当前配置：`fps: 12`、`fps_low: 1`、`fps_high: 24`、`cpu_high_ratio: 0.65`、`fps_check_sec: 1`。
- 帧率调整不再打印日志；启动摘要会显示范围。
- 摄像头采集与检测仍按 1280×720 坐标，`tape_x` 等标定不受影响。

---

## 6. 记录与 HTTP 接口

### 记录

- 每件分拣完成后写入 `/root/sorter/Record/<日期>_<时间>_P<pid>.json`。
- 字段：`pid`、`time`、`timestamp`、`province`、`category`、`servo`、`result`、`ocr_calls`。
- 写入采用 `.tmp` + 原子重命名；失败件也会记录（province 可能为空）。
- 当前记录数：961 条（含 800 条按距离广东加权生成的测试数据，时间 2026-10-31～2026-11-05；真实分拣记录从 2026-11-07 起追加）。

### 接口（端口 82）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 + 记录数量 |
| GET | `/records?limit=100&province=广东省` | 记录查询，时间倒序 |
| GET | `/records/latest` | 最近一条 |
| GET | `/logs?lines=200` | 最近日志（纯文本） |
| GET | `/docs` | Swagger 文档 |

局域网示例：
```bash
curl "http://192.168.1.102:82/records?limit=100"
curl "http://192.168.1.102:82/logs?lines=200"
```

云平台可定时拉取上述接口；板子在内网时需端口映射/内网穿透。接口无鉴权，公网暴露前应加 Token/反向代理。
详细字段、参数、错误码见 `/root/sorter/API.md`。

---

## 7. 当前关键配置

### 7.1 `/root/sorter/tuning.yaml`（32 项，启动时读取）

| 键 | 当前值 | 说明 |
|---|---|---|
| `tape_x` | 770 | 胶布中心 x 像素 |
| `front_lead_px` | 0 | 货运前沿触发补偿 |
| `back_lead_px` | -55 | 空运后沿触发补偿 |
| `exit_margin_px` | 140 | 离场余量 |
| `exit_timeout_sec` | 12 | 异常件最长等待 |
| `min_visible_ratio` | 0.85 | 锁定可见比例 |
| `ocr_max_attempts` | 2 | 单件最多 OCR 次数 |
| `ocr_retry_pulse_sec` | 0.5 | 重试前脉冲 |
| `ocr_fail_belt_run_sec` | 5.0 | 第二次失败清出时长 |
| `province_lost_stop_sec` | 1.0 | 省内目标消失后停带宽限 |
| `province_max_run_sec` | 20.0 | 省内直通最长运行 |
| `min_frames_to_lock` / `stable_frames_to_lock` | 3 / 3 | 锁定帧数 |
| `max_width_jitter` / `edge_margin_px` | 0.1 / 100 | 抖动/入画边距 |
| `max_miss_frames` / `match_max_dist` | 10 / 130 | 丢失/匹配 |
| `ghost_ttl_sec` / `lost_grace_sec` | 2.5 / 5.0 | 幽灵/丢失宽限 |
| `display_crop_x/y/w/h` | 110/230/1169/430 | 显示裁剪 |
| `display_width` / `display_height` | 640 / 235 | 显示分辨率 |
| `display_fps` / `display_flip` | 12 / true | 显示刷新/左右翻转 |
| `fps` / `fps_low` / `fps_high` | 12 / 1 / 24 | 处理帧率 |
| `cpu_high_ratio` / `fps_check_sec` | 0.65 / 1.0 | CPU 阈值/采样 |

### 7.2 `/root/sorter/servo.yaml`（每次动作读取）

| 键 | 当前值 |
|---|---|
| `servo1_mode` | position |
| `servo1_home_us` / `servo1_swing_us` | 2200 / 1200 |
| `servo1_ramp_sec` / `servo1_hold_after` | 0.2 / true |
| `servo2_home_us` / `servo2_swing_us` | 2450 / 1500 |
| `pre_home_sec` / `ramp_sec` / `hold_sec` / `tail_sec` | 0.2 / 1.0 / 1.0 / 0.3 |
| `home_hold_sec` | 2.0 |

---

## 8. 文件与目录（`/root/sorter/`）

| 文件 | 作用 |
|---|---|
| `sorter` | C++17 分拣主程序 |
| `main.cpp` / `engine.*` / `hw.*` / `ocr_client.*` / `llm_client.*` | 主程序、状态机、硬件/配置、OCR/LLM 客户端 |
| `test_engine.cpp` / `test_engine` | 引擎测试（61 项，`make test`） |
| `Makefile` | `make` 编译 sorter + servo_pwm；`make test` |
| `sorter_cpp.json` | 主配置（摄像头、检测、OCR、LLM、电机、舵机、日志） |
| `tuning.yaml` / `servo.yaml` | 调参 / 舵机角度 |
| `servo_pwm.c` / `servo_pwm` | 舵机驱动（舵机1 硬件 PWM；舵机2 软件 PWM + home 保持） |
| `belt_ctl.py` | 传送带 GPIO70 守护（低电平运行） |
| `local_ocr_server.py` / `local_ocr.py` | 本地 OCR 常驻 / 单张调试 |
| `rapidocr_config.yaml` | RapidOCR 参数 |
| `api_server.py` / `API.md` | FastAPI 接口与文档 |
| `run_gui.sh` | 带实时显示的启动脚本 |
| `llm/` | LLM 模型、llama-server 运行时与启动脚本（自包含，约 487 MB） |
| `models/ocr/` | PP-OCRv4 det/rec/cls ONNX 模型（自包含，约 16 MB） |
| `log_viewer.py` | 可选日志网页（端口 8897，手动运行） |
| `Record/` | 分拣记录 JSON |
| `captures/` | OCR 截图 |
| `sorter.log` | 运行日志 |
| `servo.yaml.bak.*` / `tuning.yaml.bad.*` | 配置修改备份 |

其他目录：

| 路径 | 说明 |
|---|---|
| `/root/sorter_cpp2` / `/root/sorter_cpp3` | 冻结历史版本 |
| `/root/backups/sorter_cpp2_20261106_103928.tar.gz` | v2 完整备份（附 sha256） |
| `/root/models/` | 历史模型目录（q4_0 等）；当前使用的 Q4_K_M 已移至 `/root/sorter/llm/` |
| `/root/llama-cpp-src/` | llama.cpp 构建历史；当前运行时已复制到 `/root/sorter/llm/bin/` |
| `/root/PROJECT_SUMMARY.md` | 本总结 |

---

## 9. 当前状态与已知事项

- 整合版已部署；引擎测试 **61/61 通过**。
- 当前未运行分拣主程序（无 `sorter` 进程）；`sorter-api` 持续运行，可查询记录/日志。
- 记录总数 961；其中 800 条为测试数据，真实记录从 2026-11-07 开始。
- 舵机 2 已改为普通位置舵机的 2450 µs home，并有 home 保持机制；如仍异常，优先检查信号线/供电/机械限位，或继续微调 home。
- 显示与处理帧率当前较高（12/24 fps）；若板子卡顿，可降低 `display_fps` 和 `fps_high`。
- 本地 OCR 首次调用需加载模型；接口无鉴权；板子 IP 可能变化。

---

## 10. 常用运维命令

```bash
# 带显示启动（开发板桌面终端）
sudo /root/sorter/run_gui.sh

# 无界面启动
cd /root/sorter && ./sorter

# 停止（运行终端 Ctrl+C，或）
sudo pkill -INT -x sorter
# 若无效：sudo pkill -TERM -x sorter

# 释放舵机2 home 保持进程
/root/sorter/servo_pwm set 2 off

# 接口服务
systemctl status sorter-api
systemctl restart sorter-api

# 测试 / 编译
cd /root/sorter && make test
cd /root/sorter && make -B sorter servo_pwm

# 日志
tail -f /root/sorter/sorter.log
curl "http://192.168.1.102:82/logs?lines=200"
```

---

## 11. 备份与安全

- v2 完整备份：`/root/backups/sorter_cpp2_20261106_103928.tar.gz`（附 `.sha256`）。
- 历史版本 `/root/sorter_cpp2`、`/root/sorter_cpp3` 冻结，不参与运行。
- 本地工作副本：`D:\RISC-V\sorter`；总结文档 `D:\RISC-V\PROJECT_SUMMARY.md`。
- 云端 OCR 密钥不写入代码；旧凭证文件已删除，本地 OCR 不需要密钥。
- HTTP 接口无鉴权，仅建议局域网使用；公网暴露前加访问控制。

---

*本文档由 Qoder 根据板端实际环境与运行状态整理，可直接编辑。*
