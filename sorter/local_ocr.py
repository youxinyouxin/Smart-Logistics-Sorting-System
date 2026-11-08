#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 OCR：PP-OCR (RapidOCR/ONNXRuntime) 单图识别。

用法: /usr/bin/python3 local_ocr.py <图片路径>
输出: 识别文本（单行）；失败输出空行并以非0退出。
说明: 面单在画面中可能是倒置的，脚本会分别识别原图与旋转180°，
      选择中文字符更多、置信度更高的结果。
"""

import sys

import cv2

try:
    from rapidocr_onnxruntime import RapidOCR
except Exception as exc:  # pragma: no cover
    print("", flush=True)
    print(f"rapidocr import failed: {exc}", file=sys.stderr)
    sys.exit(2)

_engine = None
CONFIG_PATH = "/root/sorter/rapidocr_config.yaml"


def get_engine():
    global _engine
    if _engine is None:
        try:
            _engine = RapidOCR(config_path=CONFIG_PATH)
        except Exception:
            _engine = RapidOCR()
    return _engine


def run_ocr(image_path):
    engine = get_engine()
    result, _ = engine(image_path)
    if not result:
        return "", 0.0
    texts = [item[1] for item in result]
    scores = [float(item[2]) for item in result]
    return "".join(texts), (sum(scores) / len(scores) if scores else 0.0)


def cjk_count(text):
    return sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")


def main():
    if len(sys.argv) < 2:
        print("usage: local_ocr.py <image>", file=sys.stderr)
        return 2
    path = sys.argv[1]
    img = cv2.imread(path)
    if img is None:
        print("", flush=True)
        print(f"cannot read image: {path}", file=sys.stderr)
        return 2

    text0, score0 = run_ocr(path)
    text1, score1 = "", 0.0
    if cjk_count(text0) == 0:
        # 内置方向分类未拿到中文时，回退手动旋转 180° 再试一次
        rot_path = "/tmp/local_ocr_rot.jpg"
        cv2.imwrite(rot_path, cv2.rotate(img, cv2.ROTATE_180))
        text1, score1 = run_ocr(rot_path)

    best = text0
    if (cjk_count(text1), score1) > (cjk_count(text0), score0):
        best = text1
    print(best, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
