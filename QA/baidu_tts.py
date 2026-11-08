#!/usr/bin/env python3
"""百度短文本在线合成（TTS）+ 扬声器播放

用法:
  python3 baidu_tts.py "你好，我是工厂环境助手"
  python3 baidu_tts.py --no-play "只合成不播放"
  python3 baidu_tts.py --per 1 "使用度小宇男声"
"""
import json
import os
import re
import subprocess
import sys
import time

import requests

TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token"
TTS_URL = "https://tsn.baidu.com/text2audio"
CONF_PATH = "/root/QA/qa.conf"
TOKEN_CACHE = "/root/QA/.baidu_tts_token.json"
DEFAULT_OUT = "/tmp/qa_tts_out.wav"

_UNIT_ALIAS = {
    "μg/m³": "微克每立方米",
    "µg/m³": "微克每立方米",
    "ug/m3": "微克每立方米",
    "lux": "勒克斯",
    "lx": "勒克斯",
    "ppm": "批批M",
    "co2": "二氧化碳",
}
_UNIT_PAT = re.compile(
    r"μg/m³|µg/m³|ug/m3|(?<![A-Za-z])(?:ppm|lux|lx|tvoc|hpa|co2|pm2\.5|pm10|voc|db)(?![A-Za-z])",
    re.IGNORECASE,
)


def _spread_letters(token):
    """让 TTS 逐字母读：ppm -> p,m,m,   CO2 -> C,O,2"""
    return "".join(ch + "," if ch.isalpha() else ch for ch in token)


def normalize_for_tts(text):
    def repl(m):
        tok = m.group(0)
        alias = _UNIT_ALIAS.get(tok) or _UNIT_ALIAS.get(tok.lower())
        if alias:
            return alias
        return _spread_letters(tok)
    return _UNIT_PAT.sub(repl, text)


def load_conf():
    api_key = os.environ.get("BAIDU_TTS_API_KEY", "")
    secret = os.environ.get("BAIDU_TTS_SECRET_KEY", "")
    if not (api_key and secret):
        try:
            with open(CONF_PATH, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("BAIDU_TTS_API_KEY="):
                        api_key = line.split("=", 1)[1].strip()
                    elif line.startswith("BAIDU_TTS_SECRET_KEY="):
                        secret = line.split("=", 1)[1].strip()
        except FileNotFoundError:
            pass
    if not (api_key and secret):
        raise SystemExit("缺少百度语音 API Key/Secret（环境变量或 %s）" % CONF_PATH)
    return api_key, secret


def get_token(force=False):
    if not force and os.path.exists(TOKEN_CACHE):
        try:
            with open(TOKEN_CACHE, encoding="utf-8") as f:
                c = json.load(f)
            if time.time() - c.get("ts", 0) < 25 * 86400:
                return c["token"]
        except Exception:
            pass
    api_key, secret = load_conf()
    r = requests.post(
        TOKEN_URL,
        params={
            "grant_type": "client_credentials",
            "client_id": api_key,
            "client_secret": secret,
        },
        timeout=10,
    )
    data = r.json()
    if "access_token" not in data:
        raise SystemExit(f"获取 access_token 失败: {data}")
    token = data["access_token"]
    with open(TOKEN_CACHE, "w", encoding="utf-8") as f:
        json.dump({"token": token, "ts": time.time()}, f)
    os.chmod(TOKEN_CACHE, 0o600)
    return token


def synthesize(text, out_path=DEFAULT_OUT, per=0, spd=5, pit=5, vol=5, aue=6, token=None):
    """aue: 3=mp3, 4=pcm-16k, 6=wav"""
    text = normalize_for_tts(text)
    tok = token or get_token()
    params = {
        "tex": text,
        "tok": tok,
        "cuid": "k1-board",
        "ctp": 1,
        "lan": "zh",
        "spd": spd,
        "pit": pit,
        "vol": vol,
        "per": per,
        "aue": aue,
    }
    r = requests.post(TTS_URL, data=params, timeout=30)
    ctype = r.headers.get("Content-Type", "")
    if "audio" in ctype:
        with open(out_path, "wb") as f:
            f.write(r.content)
        return out_path
    try:
        err = r.json()
    except Exception:
        err = {"raw": r.text[:200], "content_type": ctype}
    raise RuntimeError(f"合成失败: {err}")


def play(path):
    runtime = None
    for uid in ("1000", "109"):
        if os.path.exists(f"/run/user/{uid}/pipewire-0"):
            runtime = f"/run/user/{uid}"
            break
    env = dict(os.environ)
    if runtime:
        env["XDG_RUNTIME_DIR"] = runtime
        env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={runtime}/bus"
        r = subprocess.run(["pw-play", path], env=env, capture_output=True, text=True)
        if r.returncode == 0:
            return
    wav48 = path + ".48k.wav"
    r = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-ar", "48000", "-ac", "2", wav48],
        capture_output=True, text=True,
    )
    if r.returncode == 0:
        r2 = subprocess.run(["aplay", "-q", "-D", "plughw:1,0", wav48], capture_output=True, text=True)
        if r2.returncode == 0:
            return
    raise RuntimeError("播放失败：pw-play 与 ALSA 回退均不可用")


def speak(text, **kw):
    path = synthesize(text, **kw)
    play(path)
    return path


def main():
    argv = sys.argv[1:]
    no_play = "--no-play" in argv
    per = 0
    if "--per" in argv:
        i = argv.index("--per")
        if i + 1 < len(argv):
            per = int(argv[i + 1])
            del argv[i:i + 2]
    text = " ".join(a for a in argv if not a.startswith("--")).strip()
    if not text:
        text = "你好，我是工厂环境助手。"
    t0 = time.time()
    path = synthesize(text, per=per)
    t1 = time.time()
    print(f"合成完成: {path} ({os.path.getsize(path)} 字节, {(t1 - t0) * 1000:.0f} ms)")
    if not no_play:
        t2 = time.time()
        play(path)
        print(f"播放完成 ({(time.time() - t2) * 1000:.0f} ms)")


if __name__ == "__main__":
    main()
