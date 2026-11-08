#!/bin/bash
# 批量测试省份 → 快递方式（Qwen2.5-0.5B + llama-server）
CLIENT=/root/img/llm_shipping
PROVINCES=("广东省" "浙江省" "河北省" "黑龙江省" "海南省" "四川省" "北京市" "新疆" "上海市" "陕西省")

for p in "${PROVINCES[@]}"; do
  printf '%-6s  ' "$p"
  $CLIENT "{\"province\":\"$p\"}" 2>/dev/null | grep -oE '第 1 次.*'
done
