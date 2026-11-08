#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""极简实时日志查看器：浏览器打开 http://板子IP:8899

GET /        -> HTML 页面（每秒拉取一次）
GET /tail    -> 返回日志最后 N 行（?lines=200）
"""

import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

LOG_PATH = "/root/sorter/sorter.log"
PORT = 8897

PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>分拣实时日志</title>
<style>
body{background:#111;color:#d6ffd6;font:14px/1.45 Consolas,monospace;margin:0;padding:12px}
h2{color:#8fd3ff;font-size:15px;margin:0 0 8px}
pre{white-space:pre-wrap;word-break:break-all;margin:0}
.tip{color:#888;font-size:12px;margin-bottom:8px}
</style></head><body>
<h2>分拣实时日志 · __HOST__</h2><div class="tip">每秒自动刷新（保留最近 300 行）· Ctrl+F 可搜索</div>
<pre id="log">加载中…</pre>
<script>
async function pull(){
  try{
    const r = await fetch('/tail?lines=300&ts=' + Date.now());
    const t = await r.text();
    const el = document.getElementById('log');
    const stick = window.scrollY + window.innerHeight >= document.body.scrollHeight - 40;
    el.textContent = t;
    if (stick) window.scrollTo(0, document.body.scrollHeight);
  }catch(e){ document.getElementById('log').textContent = '连接失败: ' + e; }
}
pull(); setInterval(pull, 1000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            body = PAGE.replace("__HOST__", self.headers.get("Host", "")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/tail":
            n = 300
            try:
                n = int(parse_qs(parsed.query).get("lines", ["300"])[0])
            except ValueError:
                pass
            try:
                with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
                    lines = f.readlines()[-n:]
                body = "".join(lines).encode("utf-8")
            except FileNotFoundError:
                body = "（日志文件尚未生成）".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.makedirs("/root/sorter", exist_ok=True)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
