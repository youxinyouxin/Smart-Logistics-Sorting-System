#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 OCR 常驻服务：PP-OCR (RapidOCR/ONNXRuntime)。

stdin 每行一个图片路径，stdout 每行输出识别文本（空行表示失败）。
模型只加载一次；方向由内置 cls 分类器处理，失败时回退旋转 180°。
"""

import sys

import cv2

try:
    from rapidocr_onnxruntime import RapidOCR
except Exception as exc:  # pragma: no cover
    print(f"rapidocr import failed: {exc}", file=sys.stderr)
    sys.exit(2)

CONFIG_PATH = "/root/sorter/rapidocr_config.yaml"

try:
    engine = RapidOCR(config_path=CONFIG_PATH)
except Exception:
    engine = RapidOCR()


def run_ocr(image_path):
    result, _ = engine(image_path)
    if not result:
        return "", 0.0
    texts = [item[1] for item in result]
    scores = [float(item[2]) for item in result]
    return "".join(texts), (sum(scores) / len(scores) if scores else 0.0)


def cjk_count(text):
    return sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")


def recognize(path):
    img = cv2.imread(path)
    if img is None:
        return ""
    t0, s0 = run_ocr(path)
    if cjk_count(t0) > 0:
        return t0
    rot = "/tmp/local_ocr_rot.jpg"
    cv2.imwrite(rot, cv2.rotate(img, cv2.ROTATE_180))
    t1, s1 = run_ocr(rot)
    return t1 if (cjk_count(t1), s1) > (cjk_count(t0), s0) else t0


def main():
    for line in sys.stdin:
        path = line.strip()
        if not path:
            continue
        try:
            text = recognize(path)
        except Exception as exc:  # 单张失败不影响后续
            print(f"ocr error: {exc}", file=sys.stderr)
            text = ""
        print(text.replace("\n", " "), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
