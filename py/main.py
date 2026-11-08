# -*- coding: utf-8 -*-
"""采集主程序：加载配置，调用各采集模块并打印返回值。"""

import os
import sys
import threading
import time

import requests

from all_in_one_reader import MultiInOneReader
from config_loader import load_config
from iot_ai0_reader import IotAiReader
from iot_do_controller import IotDoController
from smoke_alarm import SmokeAlarm
from uhf_gate import GateController, UhfReader

API_BASE = "http://127.0.0.1:81"
AI_TEMPERATURE_CHANNEL = 2
AI_ILLUMINATION_CHANNEL = 4
_upload_warned = False


def _api_url(path):
    return API_BASE.rstrip("/") + path


def upload(source, values):
    global _upload_warned
    try:
        requests.post(_api_url("/api/data"),
                      json={"source": source, "values": values}, timeout=1)
        _upload_warned = False
    except requests.RequestException as e:
        if not _upload_warned:
            print("数据上传失败：%s（请确认 API 服务 %s 可访问）" % (e, API_BASE))
            _upload_warned = True


def record_card():
    try:
        requests.post(_api_url("/api/rfid"), timeout=1)
    except requests.RequestException as e:
        print("打卡记录上传失败：%s" % e)


def convert_iot(values):
    """A2 温度：4.375*value/1000-27.5；A4 光照：1.25*value-5000。"""
    data = dict(values)
    if data.get(AI_TEMPERATURE_CHANNEL) is not None:
        data["temperature"] = round(
            4.375 * data[AI_TEMPERATURE_CHANNEL] / 1000.0 - 27.5, 2)
    if data.get(AI_ILLUMINATION_CHANNEL) is not None:
        data["illumination"] = round(
            1.25 * data[AI_ILLUMINATION_CHANNEL] - 5000.0, 1)
    return data


def format_iot(ai_channels, di_channels, values):
    parts = []
    for channel in sorted(ai_channels):
        sensor = ai_channels[channel].get("sensor", "A%d" % channel)
        raw = values.get(channel)
        if raw is None:
            parts.append("A%d(%s)=失败" % (channel, sensor))
        elif channel == AI_TEMPERATURE_CHANNEL and "temperature" in values:
            parts.append("A%d(%s)=%.2f℃(raw %d)"
                         % (channel, sensor, values["temperature"], raw))
        elif channel == AI_ILLUMINATION_CHANNEL and "illumination" in values:
            parts.append("A%d(%s)=%.1flux(raw %d)"
                         % (channel, sensor, values["illumination"], raw))
        else:
            parts.append("A%d(%s)=%d(%.3fmA)"
                         % (channel, sensor, raw, raw / 1000.0))

    di_values = values.get("di")
    for channel in sorted(di_channels):
        name = di_channels[channel]
        if di_values is None or di_values.get(channel) is None:
            parts.append("DI%d(%s)=失败" % (channel + 1, name))
        else:
            parts.append("DI%d(%s)=%d" % (channel + 1, name, int(di_values[channel])))
    return "  ".join(parts)


def format_multi_in_one(data):
    return ("CO2=%dppm  TVOC=%dppb  温度=%d℃  湿度=%d%%RH  人体=%s  "
            "PM2.5=%dug/m3  气压=%.1fhPa"
            % (data["co2"], data["tvoc"], data["temperature"], data["humidity"],
               "有人" if data["body"] else "无人",
               data["pm2_5"], data["pressure_hpa"]))


def run(sources, smoke=None, smoke_di_channel=None):
    next_ticks = [time.monotonic() for _ in sources]
    while True:
        now = time.monotonic()
        for i, (name, label, reader, interval, fmt) in enumerate(sources):
            if now >= next_ticks[i]:
                try:
                    values = reader.read_all()
                    if name == "iot":
                        values = convert_iot(values)
                        if smoke is not None:
                            di_values = values.get("di")
                            if di_values is not None:
                                smoke.update(di_values.get(smoke_di_channel))
                    print("[%s] %s %s"
                          % (time.strftime("%H:%M:%S"), label, fmt(values)))
                    upload(name, values)
                except Exception as e:
                    print("[%s] %s 读取失败：%s" % (time.strftime("%H:%M:%S"), label, e))
                next_ticks[i] += interval
                if next_ticks[i] < time.monotonic():
                    next_ticks[i] = time.monotonic() + interval
        sys.stdout.flush()
        wait = min(next_ticks) - time.monotonic()
        if wait > 0:
            time.sleep(wait)


def main():
    global API_BASE
    config = load_config()
    API_BASE = config.get("api", {}).get("base_url", "http://127.0.0.1:81")
    iot_cfg = config["iot"]
    multi_cfg = config["multi_in_one"]
    ai_channels = iot_cfg["ai_channels"]
    di_channels = iot_cfg.get("di_channels", {}) or {}

    sources = []
    closers = []
    iot = None

    if iot_cfg["enabled"]:
        iot = IotAiReader(iot_cfg["ip"], iot_cfg["port"],
                          iot_cfg["device_addr"], sorted(ai_channels),
                          sorted(di_channels))
        closers.append(iot.close)
        sources.append(("iot", "IOT  ", iot, iot_cfg["interval"],
                        lambda v: format_iot(ai_channels, di_channels, v)))

    if multi_cfg["enabled"]:
        try:
            multi = MultiInOneReader(multi_cfg["ip"], multi_cfg["port"],
                                     multi_cfg["device_addr"], multi_cfg["timeout"])
        except OSError as e:
            print("连接多合一终端 %s:%d 失败，已跳过：%s"
                  % (multi_cfg["ip"], multi_cfg["port"], e))
        else:
            closers.append(multi.close)
            sources.append(("multi_in_one", "多合一", multi,
                            multi_cfg["interval"], format_multi_in_one))

    rfid_cfg = config.get("rfid_gate", {})
    smoke_cfg = config.get("smoke_alarm", {})
    do_controller = None
    if rfid_cfg.get("enabled") or smoke_cfg.get("enabled"):
        do_controller = IotDoController(iot_cfg["ip"], iot_cfg["port"],
                                        iot_cfg["device_addr"])
        closers.append(do_controller.close)

    gate = None
    gate_thread = None
    if rfid_cfg.get("enabled"):
        gate_reader = UhfReader(rfid_cfg["ip"], rfid_cfg["port"],
                                rfid_cfg["command"], rfid_cfg["response_timeout"])
        gate = GateController(do_controller, gate_reader,
                              open_seconds=rfid_cfg["open_seconds"],
                              green_seconds=rfid_cfg["green_seconds"],
                              close_seconds=rfid_cfg["close_seconds"],
                              poll_interval=rfid_cfg["poll_interval"],
                              tag_confirm=rfid_cfg["tag_confirm"],
                              clear_confirm=rfid_cfg["clear_confirm"],
                              start_armed=rfid_cfg["start_armed"],
                              on_card=record_card)
        gate_thread = threading.Thread(target=gate.run, daemon=True)
        gate_thread.start()
        print("大门控制已启动：读卡器 %s:%d" % (rfid_cfg["ip"], rfid_cfg["port"]))

    smoke = None
    if smoke_cfg.get("enabled"):
        if smoke_cfg["di_channel"] not in di_channels:
            print("警告：smoke_alarm.di_channel=%d 不在 iot.di_channels 中，烟雾状态不可用"
                  % smoke_cfg["di_channel"])
        if iot is None:
            print("警告：烟雾报警已启用，但 iot 采集未启用，无法获取 DI 状态")
        smoke = SmokeAlarm(do_controller, smoke_cfg["do_channel"],
                           smoke_cfg["hold_seconds"])
        smoke.start()
        print("烟雾报警已启动：DI%d -> DO%d，烟雾消失后延时 %.1f 秒关灯"
              % (smoke_cfg["di_channel"] + 1, smoke_cfg["do_channel"],
                 smoke_cfg["hold_seconds"]))

    if not sources and gate is None and smoke is None:
        print("config.yaml 中没有可用的采集项")
        return 1

    if sources:
        print("已启用：%s" % "、".join(source[1].strip() for source in sources))
    try:
        if sources:
            if iot is not None:
                iot.read_all()  # 刚连接时设备前几帧不稳定，丢弃一轮
            run(sources, smoke, smoke_cfg.get("di_channel"))
        else:
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        print("已停止")
    finally:
        if gate is not None:
            gate.stop()
            if gate_thread is not None:
                gate_thread.join(timeout=6)
        if smoke is not None:
            smoke.stop()
            smoke.join()
        for close in closers:
            close()
        os._exit(0)  # nle_library 内部线程不是守护线程，直接退出避免卡住


if __name__ == "__main__":
    sys.exit(main())
