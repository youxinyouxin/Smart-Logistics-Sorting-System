#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分拣记录 + 日志 HTTP 接口（FastAPI，端口 82）

接口:
  GET /                     服务说明
  GET /health               健康检查
  GET /records?limit=100    快递记录（按时间倒序）
  GET /records?province=广东省
  GET /records/latest       最近一条
  GET /logs?lines=200       最近日志（纯文本）
  GET /docs                 自动生成的接口文档

记录由分拣程序写入 /root/sorter/Record/*.json。
"""

import json
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse

RECORD_DIR = Path("/root/sorter/Record")
LOG_FILE = Path("/root/sorter/sorter.log")
PORT = 82

app = FastAPI(title="Sorter API", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_records(limit: int = 100) -> list:
    items = []
    try:
        files = list(RECORD_DIR.glob("*.json"))
    except OSError:
        return items
    for p in sorted(files, key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            with p.open("r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                data["_file"] = p.name
                items.append(data)
        except (OSError, ValueError):
            continue
        if len(items) >= limit:
            break
    items.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
    return items


@app.get("/")
def root():
    return {
        "service": "sorter-api",
        "port": PORT,
        "endpoints": ["/health", "/records", "/records/latest", "/logs", "/docs"],
        "record_dir": str(RECORD_DIR),
        "log_file": str(LOG_FILE),
    }


@app.get("/health")
def health():
    return {"ok": True, "records": len(list(RECORD_DIR.glob("*.json")))}


@app.get("/records")
def records(
    limit: int = Query(100, ge=1, le=5000),
    province: Optional[str] = None,
):
    items = load_records(5000 if province else limit)
    if province:
        items = [x for x in items if x.get("province") == province]
        items = items[:limit]
    return {"count": len(items), "records": items}


@app.get("/records/latest")
def latest_record():
    items = load_records(1)
    return items[0] if items else {}


@app.get("/logs", response_class=PlainTextResponse)
def logs(lines: int = Query(200, ge=1, le=5000)):
    try:
        with LOG_FILE.open("r", encoding="utf-8", errors="replace") as f:
            data = f.readlines()
        return "".join(data[-lines:])
    except FileNotFoundError:
        return ""


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
