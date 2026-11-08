#!/bin/bash
# 启动 Qwen2.5-0.5B llama-server（纯 RVV 版，8 线程，Q4_0 量化）
BIN=/root/llama-cpp-src/build-rvv/bin
MODEL=/root/models/qwen2.5-0.5b-instruct-q4_k_m.gguf

exec "$BIN/llama-server" \
  -m "$MODEL" \
  --host 127.0.0.1 --port 8080 \
  -c 1024 \
  -t 8 \
  --jinja \
  --metrics
