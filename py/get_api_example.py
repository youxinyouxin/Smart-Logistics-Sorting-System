# -*- coding: utf-8 -*-
"""GET 示例：读取本机 81 端口上的最新采集数据（独立运行，不被 main.py 调用）。"""

import json
import sys

import requests

URL = "http://127.0.0.1:81/api/data"


def main():
    try:
        resp = requests.get(URL, timeout=3)
        resp.raise_for_status()
    except requests.RequestException as e:
        print("请求 %s 失败：%s" % (URL, e))
        print("请先启动 api_server.py")
        return 1
    print(json.dumps(resp.json(), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
