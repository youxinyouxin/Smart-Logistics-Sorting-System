# -*- coding: utf-8 -*-
"""FastAPI 数据服务：接收采集数据、提供实时/历史查询、环境联动和打卡记录。

启动：python api_server.py
"""

import json
import os
import random
import threading
import time
from datetime import datetime

import uvicorn
from fastapi import FastAPI, HTTPException, Request

from config_loader import load_config
from data_store import DEFAULT_RECORD_DIR, DataRecorder, RfidStore
from iot_do_controller import IotDoController

CONFIG = load_config()
IOT_CFG = CONFIG["iot"]
MULTI_CFG = CONFIG.get("multi_in_one", {})
SMOKE_CFG = CONFIG.get("smoke_alarm", {})
CONTROL_CFG = CONFIG.get("control", {})

app = FastAPI(title="采集数据服务")
LATEST = {}
DO = IotDoController(IOT_CFG["ip"], IOT_CFG["port"], IOT_CFG["device_addr"])
RECORDER = DataRecorder()
RFID = RfidStore()

SETTINGS_PATH = os.path.join(DEFAULT_RECORD_DIR, "control_settings.json")
STALE_SECONDS = 15
CONTROL_LOCK = threading.Lock()
_last_control_error = 0.0

CONTROL = {
    "pm25_threshold": float(CONTROL_CFG.get("pm25_threshold", 75)),
    "light_threshold": float(CONTROL_CFG.get("light_threshold", 200)),
    "fan_do": int(CONTROL_CFG.get("fan_do", 1)),
    "light_do": int(CONTROL_CFG.get("light_do", 2)),
}

ENABLED_SOURCES = []
if IOT_CFG.get("enabled"):
    ENABLED_SOURCES.append("iot")
if MULTI_CFG.get("enabled"):
    ENABLED_SOURCES.append("multi_in_one")

HISTORY_METRICS = {
    "temperature": {"unit": "℃", "sources": ["multi_in_one", "iot"]},
    "humidity": {"unit": "%RH", "sources": ["multi_in_one"]},
    "illumination": {"unit": "lux", "sources": ["iot"]},
}


def _load_control_settings():
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return
    for key in ("pm25_threshold", "light_threshold"):
        value = data.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            CONTROL[key] = float(value)


def _save_control_settings():
    try:
        tmp = SETTINGS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({
                "pm25_threshold": CONTROL["pm25_threshold"],
                "light_threshold": CONTROL["light_threshold"],
            }, f, ensure_ascii=False, indent=2)
        os.replace(tmp, SETTINGS_PATH)
    except OSError as e:
        print("保存控制阈值失败：%s" % e)


_load_control_settings()


def _is_fresh(entry):
    return entry is not None and (time.time() - entry.get("updated_ts", 0)) <= STALE_SECONDS


def _merged_values(hist, live):
    merged = dict(hist or {})
    for key, value in live.items():
        if key == "di":
            continue
        if value is not None:
            merged[key] = value

    hist_di = (hist or {}).get("di")
    live_di = live.get("di")
    if isinstance(hist_di, dict) or isinstance(live_di, dict):
        di = {}
        if isinstance(hist_di, dict):
            di.update(hist_di)
        if isinstance(live_di, dict):
            di.update(live_di)
        merged["di"] = di
    return merged


def _effective_values(source):
    live = LATEST.get(source)
    hist = RECORDER.latest(source)
    if _is_fresh(live):
        return _merged_values(hist["values"] if hist else None, live["values"]), True
    if hist is not None:
        return dict(hist["values"]), False
    if live is not None:
        return dict(live["values"]), False
    return {}, False


def _force_smoke_zero(values, live_fresh):
    channel = str(SMOKE_CFG.get("di_channel", 0))
    di = values.get("di")
    if live_fresh and isinstance(di, dict) and channel in di:
        return values
    new_values = dict(values)
    new_di = dict(di) if isinstance(di, dict) else {}
    new_di[channel] = False
    new_values["di"] = new_di
    return new_values


def _set_control_do(channel, value):
    global _last_control_error
    try:
        status = DO.read_status()
        if status.get("DO%d" % channel) != value:
            DO.set(channel, value)
    except Exception as e:
        now = time.time()
        if now - _last_control_error >= 10:
            print("联动控制 DO%d 失败：%s" % (channel, e))
            _last_control_error = now


def apply_control():
    # 风扇（DO1）和照明灯（DO2）的自动触发策略暂时停用。
    # 恢复时取消下面注释即可。
    # with CONTROL_LOCK:
    #     multi_values, _ = _effective_values("multi_in_one")
    #     pm25 = multi_values.get("pm2_5")
    #     if pm25 is not None:
    #         if pm25 > CONTROL["pm25_threshold"]:
    #             _set_control_do(CONTROL["fan_do"], True)
    #         elif pm25 < CONTROL["pm25_threshold"]:
    #             _set_control_do(CONTROL["fan_do"], False)
    #
    #     iot_values, _ = _effective_values("iot")
    #     light = iot_values.get("illumination")
    #     if light is not None:
    #         if light < CONTROL["light_threshold"]:
    #             _set_control_do(CONTROL["light_do"], True)
    #         elif light > CONTROL["light_threshold"]:
    #             _set_control_do(CONTROL["light_do"], False)
    pass


@app.get("/")
def index():
    return {"service": "采集数据服务", "endpoints": [
        "POST /api/data", "GET /api/data",
        "GET /api/control", "POST /api/control",
        "GET /api/rfid", "POST /api/rfid",
        "GET /api/history/{metric}",
        "GET /api/do", "GET /api/do/{channel}", "POST /api/do/{channel}",
    ]}


@app.post("/api/data")
async def upload(request: Request):
    data = await request.json()
    source = data.get("source")
    values = data.get("values")
    if not source or not isinstance(values, dict):
        raise HTTPException(status_code=400, detail="需要 source 和 values 字段")
    LATEST[source] = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "updated_ts": time.time(),
        "values": values,
    }
    RECORDER.add(source, values)
    apply_control()
    return {"ok": True, "source": source}


@app.get("/api/data")
def get_data():
    result = {}
    for source in ENABLED_SOURCES:
        live = LATEST.get(source)
        hist = RECORDER.latest(source)
        if live is None and hist is None:
            continue
        if _is_fresh(live):
            values = _merged_values(hist["values"] if hist else None, live["values"])
            entry = {"updated_at": live["updated_at"], "source": "live"}
        elif hist is not None:
            values = dict(hist["values"])
            entry = {"updated_at": hist["minute"], "source": "history"}
        else:
            values = dict(live["values"])
            entry = {"updated_at": live["updated_at"], "source": "stale"}

        if source == "iot":
            values = _force_smoke_zero(values, _is_fresh(live))
        entry["values"] = values
        result[source] = entry
    return result


def _parse_history_time(value, name):
    if value is None:
        return None
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y%m%d_%H%M"):
        try:
            return datetime.strptime(value, fmt).strftime("%Y-%m-%d %H:%M")
        except ValueError:
            continue
    raise HTTPException(status_code=400,
                        detail="%s 格式应为 YYYY-MM-DD HH:MM" % name)


@app.get("/api/history/{metric}")
def get_history(metric: str, start: str = None, end: str = None,
                source: str = None, limit: int = 60):
    if metric not in HISTORY_METRICS:
        raise HTTPException(
            status_code=404,
            detail="metric 仅支持 temperature / humidity / illumination")
    if not 1 <= limit <= 1440:
        raise HTTPException(status_code=400, detail="limit 必须在 1~1440 之间")

    start_minute = _parse_history_time(start, "start")
    end_minute = _parse_history_time(end, "end")
    if start_minute and end_minute and start_minute > end_minute:
        raise HTTPException(status_code=400, detail="start 不能晚于 end")

    conf = HISTORY_METRICS[metric]
    sources = list(conf["sources"])
    if source:
        if source not in sources:
            raise HTTPException(status_code=400,
                                detail="source 仅支持 %s" % " / ".join(sources))
        sources = [source]

    minutes = RECORDER.minutes(start_minute, end_minute)
    if len(minutes) > limit:
        minutes = minutes[-limit:]

    records = []
    for item in minutes:
        for src in sources:
            values = item["sources"].get(src, {}).get("values", {})
            value = values.get(metric)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                records.append({
                    "minute": item["minute"],
                    "source": src,
                    "value": round(float(value), 2),
                })

    return {
        "metric": metric,
        "unit": conf["unit"],
        "start": start_minute,
        "end": end_minute,
        "count": len(records),
        "records": records,
    }


@app.get("/api/control")
def get_control():
    return dict(CONTROL)


@app.post("/api/control")
async def set_control(request: Request):
    try:
        data = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="请求体必须是 JSON")
    changed = False
    for key in ("pm25_threshold", "light_threshold"):
        if key in data:
            value = data[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise HTTPException(status_code=400, detail="%s 必须是数字" % key)
            if value < 0:
                raise HTTPException(status_code=400, detail="%s 不能小于 0" % key)
            CONTROL[key] = float(value)
            changed = True
    if not changed:
        raise HTTPException(status_code=400,
                            detail="至少提供 pm25_threshold 或 light_threshold")
    _save_control_settings()
    apply_control()
    return dict(CONTROL)


@app.post("/api/rfid")
def add_rfid():
    return RFID.add(random.choice(["小明", "小黄"]))


@app.get("/api/rfid")
def get_rfid(start: int = 1, count: int = 10):
    if start < 1:
        raise HTTPException(status_code=400, detail="start 从 1 开始")
    if not 1 <= count <= 100:
        raise HTTPException(status_code=400, detail="count 必须在 1~100 之间")
    total, records = RFID.page(start, count)
    return {"total": total, "start": start, "count": count, "records": records}


@app.get("/api/do")
def get_do_status():
    return DO.read_status()


@app.get("/api/do/{channel}")
def get_do(channel: int):
    if not 1 <= channel <= 8:
        raise HTTPException(status_code=400, detail="通道号必须在 1~8 之间")
    return {"channel": channel, "value": DO.read_status()["DO%d" % channel]}


@app.post("/api/do/{channel}")
async def set_do(channel: int, request: Request):
    if not 1 <= channel <= 8:
        raise HTTPException(status_code=400, detail="通道号必须在 1~8 之间")
    try:
        data = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="请求体必须是 JSON")
    value = data.get("value")
    if not isinstance(value, bool):
        raise HTTPException(status_code=400, detail="value 必须是 true 或 false")
    try:
        DO.set(channel, value)
    except OSError as e:
        raise HTTPException(status_code=502, detail="控制失败：%s" % e)
    return {"channel": channel, "value": value}


@app.on_event("shutdown")
def flush_records():
    RECORDER.flush()


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=81)
