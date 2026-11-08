#!/bin/bash
# 批量测试省份 → 快递方式（Qwen2.5-0.5B + llama-server）
CLIENT=/root/img/llm_shipping
PROVINCES=("江苏省" "湖北省" "内蒙古" "天津市" "甘肃省" "贵州省" "江西省" "福建省" "辽宁省" "吉林省" "山东省" "河南省" "山西省" "青海省" "宁夏" "西藏" "重庆市" "云南省" "安徽省" "广西" "湖南省")

for p in "${PROVINCES[@]}"; do
  printf '%-6s  ' "$p"
  $CLIENT "{\"province\":\"$p\"}" 2>/dev/null | grep -oE '第 1 次.*'
done
