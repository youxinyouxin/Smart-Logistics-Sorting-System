#!/bin/bash
# 重启语音助手
pkill -f 'python3 -u voice_chat.py' 2>/dev/null
sleep 1
cd /root/QA
nohup python3 -u voice_chat.py > voice.log 2>&1 &
sleep 2
echo STARTED
tail -3 /root/QA/voice.log
