# QA 目录 — K1 工厂环境与设备 AI 助手

文字/语音问答：Qwen3-8B（硅基流动云端）+ function calling + 本机采集服务 API + 百度语音合成。

## 目录结构

```
/root/QA/
├── agent_chat.py        # 主程序：问答、工具调用、语音播报
├── baidu_tts.py         # 百度短文本语音合成模块（可单独命令行使用）
├── qa.conf              # 统一配置（权限 600，三个密钥）
├── .baidu_tts_token.json# 百度 access_token 缓存（自动生成，25 天）
└── README.md            # 本文件
```

## 配置（qa.conf）

```
SILICONFLOW_API_KEY=...        # 硅基流动（Qwen3-8B）
BAIDU_TTS_API_KEY=...          # 百度语音合成
BAIDU_TTS_SECRET_KEY=...
```

## 用法

```bash
cd /root/QA

# 文字问答（单次）
python3 agent_chat.py "现在环境怎么样"

# 文字问答 + 语音播报
python3 agent_chat.py --speak "今天处理了多少件快递"

# 交互模式（输入 q 退出）
python3 agent_chat.py

# 单独测试语音合成
python3 baidu_tts.py "你好，我是工厂环境助手"
python3 baidu_tts.py --no-play "只合成不播放"
```

## 可用工具（function calling）

| 工具 | 作用 | 后端 |
|------|------|------|
| get_env_data | 环境数据（温度/湿度/光照/CO2/PM2.5/气压） | GET http://192.168.1.101:81/api/data |
| get_do_status | 8 路继电器状态 | GET /api/do |
| set_do | 控制继电器（1-8，true=开/false=关） | POST /api/do/{channel} |
| get_today_count | 今日已处理快递件数（当前固定 1205） | 本地常量 |

## 行为约定

- 环境回答不包含人体感应，不回答"有人/无人"。
- 控制指令执行成功后直接本地确认（"已打开灯光和排气扇"），不等云端第二轮。
- 云端 429/超时：重试一次后走本地模板兜底（直接播报 API 实时数据）。
- set_do 失败时不会自动换通道重试。
- 语音播报前自动转换单位：lux→勒克斯、ppm→批批M、CO2→二氧化碳、μg/m³→微克每立方米。

## 依赖

系统自带 python3.12 + requests；TTS 播放走 PipeWire（自动检测 /run/user/{1000,109}）或 ffmpeg+aplay 回退；本机采集服务需运行在 192.168.1.101:81。
