#!/usr/bin/env python3
"""百度短语音识别（ASR）+ 麦克风 VAD 录音

用法:
  python3 baidu_asr.py                  # 录一句并识别（调试）
  python3 baidu_asr.py --file x.wav     # 识别指定 wav
"""
import os
import struct
import subprocess
import sys
import time
from collections import deque

import requests

from baidu_tts import get_token

ASR_URL = "https://vop.baidu.com/server_api"
RECORD_DEVICE = os.environ.get("QA_MIC", "plughw:0,0")
SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000
FRAME_BYTES = FRAME_SAMPLES * 2


def _rms(frame):
    n = len(frame) // 2
    if n == 0:
        return 0.0
    vals = struct.unpack("<%dh" % n, frame)
    return (sum(v * v for v in vals) / n) ** 0.5


def recognize(pcm, dev_pid=1537):
    """pcm: 16k/16bit/mono raw bytes"""
    if len(pcm) < FRAME_BYTES * 5:
        raise ValueError("音频太短")
    token = get_token()
    r = requests.post(
        ASR_URL,
        params={"dev_pid": dev_pid, "cuid": "k1-board", "token": token},
        data=pcm,
        headers={"Content-Type": "audio/pcm;rate=%d" % SAMPLE_RATE},
        timeout=30,
    )
    data = r.json()
    if data.get("err_no") == 0:
        return "".join(data.get("result", [])).strip()
    raise RuntimeError("ASR 失败: %s" % data)


class VADRecorder:
    """按帧能量检测说话起止，录一句完整语音"""

    def __init__(self, device=RECORD_DEVICE, trigger_ratio=2.8, min_threshold=350,
                 start_frames=3, end_silence_ms=650, preroll_ms=300,
                 min_voice_ms=300, max_voice_ms=10000, verbose=True):
        self.device = device
        self.trigger_ratio = trigger_ratio
        self.min_threshold = min_threshold
        self.start_frames = start_frames
        self.end_silence_frames = max(1, end_silence_ms // FRAME_MS)
        self.preroll_frames = max(1, preroll_ms // FRAME_MS)
        self.min_voice_frames = max(1, min_voice_ms // FRAME_MS)
        self.max_voice_frames = max(1, max_voice_ms // FRAME_MS)
        self.verbose = verbose
        self.threshold = None
        self.base_noise = None

    def _read_frame(self, proc):
        buf = b""
        while len(buf) < FRAME_BYTES:
            chunk = proc.stdout.read(FRAME_BYTES - len(buf))
            if not chunk:
                return b""
            buf += chunk
        return buf

    def _calibrate(self, proc, frames=20):
        samples = []
        for _ in range(frames):
            f = self._read_frame(proc)
            if not f:
                break
            samples.append(_rms(f))
        base = sorted(samples)[len(samples) // 2] if samples else 0.0
        self.base_noise = base
        self.threshold = max(base * self.trigger_ratio, self.min_threshold)
        if self.verbose:
            print(f"  [VAD] 底噪 RMS={base:.0f} 触发阈值={self.threshold:.0f}")

    def record(self):
        """阻塞直到录完一句；无有效语音返回 None"""
        cmd = ["arecord", "-D", self.device, "-f", "S16_LE", "-r", str(SAMPLE_RATE),
               "-c", "1", "-t", "raw", "-q"]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            self._calibrate(proc)
            preroll = deque(maxlen=self.preroll_frames)
            voiced = bytearray()
            started = False
            start_count = 0
            silence_frames = 0
            voice_frames = 0
            while True:
                frame = self._read_frame(proc)
                if not frame:
                    break
                r = _rms(frame)
                if not started:
                    preroll.append(frame)
                    if r > self.threshold:
                        start_count += 1
                        if start_count >= self.start_frames:
                            started = True
                            voiced.extend(b"".join(preroll))
                            voice_frames = len(preroll)
                            silence_frames = 0
                    else:
                        start_count = 0
                else:
                    voiced.extend(frame)
                    voice_frames += 1
                    if r > self.threshold:
                        silence_frames = 0
                    else:
                        silence_frames += 1
                        if silence_frames >= self.end_silence_frames:
                            break
                    if voice_frames >= self.max_voice_frames:
                        break
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except Exception:
                proc.kill()
        if not started or voice_frames < self.min_voice_frames:
            return None
        return bytes(voiced)


def wav_to_pcm(path):
    """wav -> 16k/16bit/mono raw pcm（用 ffmpeg 统一格式）"""
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-acodec", "pcm_s16le",
         "-ar", str(SAMPLE_RATE), "-ac", "1", "-"],
        capture_output=True,
    )
    if r.returncode != 0:
        raise RuntimeError("ffmpeg 解码失败: %s" % r.stderr.decode()[:200])
    return r.stdout


def main():
    if "--file" in sys.argv:
        path = sys.argv[sys.argv.index("--file") + 1]
        pcm = wav_to_pcm(path)
        print(f"[文件] {path} -> {len(pcm)} bytes PCM")
        print("[识别]", recognize(pcm))
        return
    print("VAD 录音测试：请说话……")
    vad = VADRecorder()
    pcm = vad.record()
    if not pcm:
        print("未检测到有效语音")
        return
    print(f"录音 {len(pcm) / (SAMPLE_RATE * 2):.2f} 秒，识别中……")
    t0 = time.time()
    text = recognize(pcm)
    print(f"[识别] {text}  ({(time.time() - t0) * 1000:.0f} ms)")


if __name__ == "__main__":
    main()
