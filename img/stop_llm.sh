#!/bin/bash
# 停止 llama-server
pkill -f 'bin/llama-server' 2>/dev/null
sleep 1
echo STOPPED
