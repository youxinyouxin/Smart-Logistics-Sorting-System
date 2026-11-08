#!/usr/bin/env python3
"""工厂环境与设备助手 agent
Qwen3-8B（硅基流动）+ function calling + 本机采集服务 API

用法:
  python3 agent_chat.py "现在环境怎么样"
  python3 agent_chat.py            # 交互模式
"""
import json
import os
import sys
import time

import requests

BASE_URL = "https://api.siliconflow.cn/v1/chat/completions"
MODEL = "Qwen/Qwen3-8B"
IOT_API = "http://192.168.1.101:81"
TODAY_PACKAGE_COUNT = 1205
CONF_PATH = "/root/QA/qa.conf"


def load_api_key():
    key = os.environ.get("SILICONFLOW_API_KEY", "").strip()
    if key:
        return key
    try:
        with open(CONF_PATH, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("SILICONFLOW_API_KEY="):
                    return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    raise SystemExit(f"未找到 API Key：请设置环境变量 SILICONFLOW_API_KEY 或写入 {CONF_PATH}")


API_KEY = load_api_key()

SYSTEM_PROMPT = (
    "你是工厂环境与设备助手。可用工具：get_env_data（获取环境数据）、"
    "get_do_status（查询继电器状态）、set_do（控制继电器开关）。\n"
    "规则：\n"
    "1. 用户询问温度、湿度、光照、CO2、PM2.5、是否有人或环境状况时，先调用 get_env_data 获取实时数据再回答。\n"
    "2. 用户询问设备、继电器、开关状态时，调用 get_do_status。\n"
    "3. 用户明确要求打开或关闭某个通道时，调用 set_do。\n"
    "4. 用户询问今天处理了多少件快递时，调用 get_today_count。\n"
    "5. 只根据工具返回的数据回答，不要编造；回答用简洁中文，不超过 40 字。\n"
    "6. 回答环境问题时不要提人体感应、有人或无人。\n"
    "7. 调用 set_do 失败时不要尝试其他通道，直接告知用户控制失败。\n"
    "/no_think"
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_env_data",
            "description": "获取工厂当前环境数据（温度、湿度、光照、CO2、PM2.5、是否有人的等）",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_do_status",
            "description": "查询 8 路继电器（DO1-DO8）当前的开关状态",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_today_count",
            "description": "获取今天已处理的快递件数",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_do",
            "description": "打开或关闭指定通道的继电器（DO1-DO8）",
            "parameters": {
                "type": "object",
                "properties": {
                    "channel": {"type": "integer", "description": "通道号，1-8"},
                    "value": {"type": "boolean", "description": "true=打开，false=关闭"},
                },
                "required": ["channel", "value"],
            },
        },
    },
]

FIELD_CN = {
    "temperature": "温度", "humidity": "湿度", "illumination": "光照",
    "co2": "CO2", "tvoc": "TVOC", "pm2_5": "PM2.5", "pm10": "PM10",
    "pressure_hpa": "气压(hPa)", "pressure": "气压(kPa)", "noise": "噪音", "body": "人体感应",
}


def pretty_env(data):
    """把 /api/data 的嵌套 JSON 转成便于模型阅读的短文本"""
    lines = []
    for src, obj in data.items():
        if not isinstance(obj, dict):
            continue
        vals = obj.get("values") or {}
        parts = []
        for k, v in vals.items():
            if src == "iot" and k in ("0", "2", "4"):
                continue
            if k == "body":
                continue
            if isinstance(v, (dict, list)):
                continue
            name = FIELD_CN.get(k, k)
            if isinstance(v, bool):
                v = "有人" if v else "无人"
            parts.append(f"{name}={v}")
        if parts:
            lines.append(f"{src}: " + "，".join(parts) + f"（更新于 {obj.get('updated_at', '')}）")
    return "\n".join(lines) if lines else "暂无采集数据"


def call_tool(name, args):
    try:
        if name == "get_env_data":
            r = requests.get(f"{IOT_API}/api/data", timeout=5)
            r.raise_for_status()
            return pretty_env(r.json())
        if name == "get_do_status":
            r = requests.get(f"{IOT_API}/api/do", timeout=5)
            r.raise_for_status()
            return json.dumps(r.json(), ensure_ascii=False)
        if name == "get_today_count":
            return f"今天已处理快递 {TODAY_PACKAGE_COUNT} 件"
        if name == "set_do":
            ch = int(args.get("channel", 0))
            val = bool(args.get("value", False))
            r = requests.post(f"{IOT_API}/api/do/{ch}", json={"value": val}, timeout=5)
            r.raise_for_status()
            return json.dumps(r.json(), ensure_ascii=False)
        return f"未知工具: {name}"
    except requests.exceptions.RequestException as e:
        return f"调用数据接口失败: {e}"
    except Exception as e:
        return f"工具执行异常: {e}"


def chat_once(messages, retries=1):
    body = {
        "model": MODEL,
        "messages": messages,
        "tools": TOOLS,
        "tool_choice": "auto",
        "temperature": 0.3,
        "max_tokens": 512,
        "enable_thinking": False,
        "stream": False,
    }
    last_err = None
    for attempt in range(retries + 1):
        r = requests.post(
            BASE_URL,
            headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
            json=body,
            timeout=15,
        )
        if r.status_code == 200:
            return r.json()
        last_err = RuntimeError(f"API {r.status_code}: {r.text[:300]}")
        if r.status_code == 429 and attempt < retries:
            time.sleep(5)
            continue
        raise last_err
    raise last_err


def confirm_control(user_text, args):
    """控制指令成功后直接用确认语回复，不再请求云端"""
    val = bool(args.get("value"))
    text = user_text.strip()
    if val:
        for w in ("打开", "开启", "启动"):
            if w in text:
                return text.replace(w, "已打开", 1)
    else:
        for w in ("关闭", "关掉", "关上", "停止"):
            if w in text:
                return text.replace(w, "已关闭", 1)
    return f"已{'打开' if val else '关闭'} {args.get('channel')} 号通道"


def _speechify(text):
    """把 pretty_env 文本清洗成适合播报的短句"""
    import re
    text = re.sub(r"（更新于[^）]*）", "", text)
    for tag in ("iot:", "multi_in_one:", "louver_box:"):
        text = text.replace(tag, "")
    text = text.replace("\n", "，").replace("=", " ")
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"，+", "，", text)
    return text.strip("， ")


def local_fallback(user_text):
    """云端不可用时：按关键词调工具，直接模板化回答"""
    data = None
    if any(k in user_text for k in ("环境", "温度", "湿度", "光照", "CO2", "pm2.5", "PM2.5", "气压")):
        data = call_tool("get_env_data", {})
        return "当前环境：" + _speechify(data)
    if any(k in user_text for k in ("继电器", "开关", "通道")):
        data = call_tool("get_do_status", {})
        return f"继电器状态：{data}"
    if any(k in user_text for k in ("多少件", "件数", "处理了")):
        return call_tool("get_today_count", {})
    return "云端模型暂时不可用，请稍后再试。"


def run_round(user_text, verbose=True):
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_text},
    ]
    t0 = time.time()
    try:
        for _ in range(6):
            resp = chat_once(messages)
            msg = resp["choices"][0]["message"]
            tool_calls = msg.get("tool_calls")
            if tool_calls:
                messages.append(msg)
                for tc in tool_calls:
                    fn = tc["function"]["name"]
                    try:
                        args = json.loads(tc["function"].get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    if verbose:
                        print(f"  [工具调用] {fn}({json.dumps(args, ensure_ascii=False)})")
                    result = call_tool(fn, args)
                    if verbose:
                        print(f"  [工具返回] {result[:300]}")
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": str(result),
                    })
                    if fn == "set_do" and result.strip().startswith("{") and "channel" in result:
                        answer = confirm_control(user_text, args)
                        if verbose:
                            print(f"  [控制成功] {answer}")
                        return answer, round((time.time() - t0) * 1000)
                continue
            answer = (msg.get("content") or "").strip()
            return answer, round((time.time() - t0) * 1000)
        return "（工具调用次数超过上限）", round((time.time() - t0) * 1000)
    except Exception as e:
        if verbose:
            print(f"  [云端失败] {e}")
        answer = local_fallback(user_text)
        if verbose:
            print("  [已切换本地模型兜底]")
        return answer, round((time.time() - t0) * 1000)


def main():
    speak_mode = "--speak" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--speak"]

    def speak(answer):
        if not speak_mode:
            return
        try:
            import baidu_tts
            t = time.time()
            baidu_tts.speak(answer)
            print(f"（语音播报 {(time.time() - t) * 1000:.0f} ms）")
        except Exception as e:
            print(f"[TTS 失败] {e}")

    if args:
        answer, ms = run_round(" ".join(args).strip())
        print(answer)
        print(f"（耗时 {ms} ms）")
        speak(answer)
        return
    print("工厂环境助手（Qwen3-8B + 工具调用，输入 q 退出）")
    while True:
        try:
            q = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if q in ("q", "quit", "exit"):
            break
        if not q:
            continue
        answer, ms = run_round(q)
        print(answer)
        print(f"（耗时 {ms} ms）")
        speak(answer)


if __name__ == "__main__":
    main()
