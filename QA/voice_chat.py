#!/usr/bin/env python3
"""语音助手主循环：唤醒词「小新同学」→ ASR → agent 问答 → TTS 播报

用法:
  python3 voice_chat.py

流程:
  常驻监听 → VAD 检测一句话 → 百度 ASR
  → 唤醒词匹配（支持模糊：小欣/小兴/小星同学）
      ├─ 未命中 → 丢弃，继续监听
      ├─ 只有唤醒词 → 播报"我在"，再录一句指令
      └─ 唤醒词+指令 → 直接处理
  → agent_chat 工具调用 → 回答 → 百度 TTS 播报 → 回到监听
"""
import re
import time

import agent_chat
import baidu_asr
import baidu_tts


def normalize(text):
    return re.sub(r"[\s，。！？、,.!?;；:：“”\"'’]", "", text)


WAKE_PATTERNS = [
    "小新同学", "小欣同学", "小兴同学", "小星同学", "小鑫同学", "小心同学", "小辛同学",
    "小新童鞋", "小新同學",
]


def extract_command(text):
    """返回 None=未唤醒, ''=仅唤醒, 非空=去掉唤醒词后的指令"""
    t = normalize(text)
    for w in WAKE_PATTERNS:
        w = normalize(w)
        if w in t:
            idx = t.find(w)
            return t[idx + len(w):]
    m = re.search(r"小[新欣兴星鑫心辛]同学", t)
    if m:
        return t[m.end():]
    return None


def listen_once(vad):
    pcm = vad.record()
    if not pcm:
        return None
    dur = len(pcm) / (baidu_asr.SAMPLE_RATE * 2)
    print(f"[录音] {dur:.1f} 秒")
    try:
        text = baidu_asr.recognize(pcm)
    except RuntimeError as e:
        msg = str(e)
        if any(code in msg for code in ("3307", "3310", "3301")):
            print("  （无效语音，忽略）")
            return None
        raise
    print(f"[识别] {text}")
    return text


def main():
    print("语音助手已启动，唤醒词：小新同学（Ctrl+C 退出）")
    vad = baidu_asr.VADRecorder()
    while True:
        try:
            text = listen_once(vad)
            if text is None:
                continue
            cmd = extract_command(text)
            if cmd is None:
                continue
            if not cmd:
                baidu_tts.speak("我在")
                text = listen_once(vad)
                if text is None:
                    continue
                cmd = normalize(text)
            if not cmd:
                continue
            print(f"[指令] {cmd}")
            answer, ms = agent_chat.run_round(cmd)
            print(f"[回答] {answer}  ({ms} ms)")
            baidu_tts.speak(answer)
        except KeyboardInterrupt:
            print("\n已退出")
            break
        except Exception as e:
            print(f"[错误] {e}")
            time.sleep(1)
            continue


if __name__ == "__main__":
    main()
