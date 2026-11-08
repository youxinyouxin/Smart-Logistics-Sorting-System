#!/bin/bash
# 重启 llama-server（匹配所有构建目录的进程）
pkill -f 'bin/llama-server' 2>/dev/null
for i in $(seq 1 10); do
  pgrep -f 'bin/llama-server' >/dev/null || break
  sleep 1
done
nohup /root/img/run_llm_server.sh > /root/llm_server.log 2>&1 &
sleep 4
echo RESTARTED
