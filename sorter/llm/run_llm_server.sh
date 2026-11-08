#!/bin/bash
# 启动 Qwen2.5-0.5B llama-server（RVV，8 线程，Q4_K_M）
# 模型与运行时均位于本脚本所在目录（/root/sorter/llm）。
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="$BASE/bin${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

exec "$BASE/bin/llama-server" \
  -m "$BASE/qwen2.5-0.5b-instruct-q4_k_m.gguf" \
  --host 127.0.0.1 --port 8080 \
  -c 1024 \
  -t 8 \
  --jinja \
  --metrics
