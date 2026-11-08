# -*- coding: utf-8 -*-
"""采集数据按分钟存储、RFID 打卡记录存储。"""

import json
import os
import threading
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_RECORD_DIR = os.path.join(BASE_DIR, "record")


class DataRecorder(object):
    def __init__(self, record_dir=DEFAULT_RECORD_DIR):
        self.record_dir = record_dir
        if not os.path.isdir(self.record_dir):
            os.makedirs(self.record_dir)
        self._lock = threading.Lock()
        self._minute = self._now_minute()
        self._acc = {}
        self._samples = {}
        self._latest = {}
        self._stop = threading.Event()
        self._load_latest()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    @staticmethod
    def _now_minute():
        return datetime.now().strftime("%Y-%m-%d %H:%M")

    def _file_for_minute(self, minute):
        stamp = datetime.strptime(minute, "%Y-%m-%d %H:%M").strftime("%Y%m%d_%H%M")
        return os.path.join(self.record_dir, stamp + ".json")

    def add(self, source, values):
        now_minute = self._now_minute()
        with self._lock:
            if now_minute != self._minute:
                self._flush_locked()
                self._minute = now_minute
            acc = self._acc.setdefault(source, {})
            self._samples[source] = self._samples.get(source, 0) + 1
            for key, value in values.items():
                if key == "di":
                    if isinstance(value, dict):
                        acc[key] = {"last": dict(value)}
                    continue
                if isinstance(value, bool):
                    acc[key] = {"last": bool(value)}
                elif isinstance(value, (int, float)):
                    item = acc.setdefault(key, {"sum": 0.0, "count": 0})
                    item["sum"] += float(value)
                    item["count"] += 1
                elif isinstance(value, dict):
                    acc[key] = {"last": dict(value)}
                elif value is not None:
                    acc[key] = {"last": value}

    def _build_locked(self):
        sources = {}
        for source, fields in self._acc.items():
            values = {}
            for key, item in fields.items():
                if "sum" in item and item["count"]:
                    values[key] = round(item["sum"] / item["count"], 2)
                elif "last" in item:
                    values[key] = item["last"]
            sources[source] = {
                "values": values,
                "samples": self._samples.get(source, 0),
            }
        return sources

    def _flush_locked(self):
        if not self._acc:
            return
        minute = self._minute
        sources = self._build_locked()
        path = self._file_for_minute(minute)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"minute": minute, "sources": sources}, f,
                      ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        for source, item in sources.items():
            self._latest[source] = {"minute": minute, "values": item["values"]}
        self._acc = {}
        self._samples = {}

    def _run(self):
        while not self._stop.wait(0.5):
            with self._lock:
                if self._now_minute() != self._minute:
                    self._flush_locked()
                    self._minute = self._now_minute()

    def flush(self):
        with self._lock:
            self._flush_locked()
            self._minute = self._now_minute()

    def _load_latest(self):
        try:
            names = sorted(
                [n for n in os.listdir(self.record_dir)
                 if n.endswith(".json") and n[0].isdigit()],
                reverse=True)
        except OSError:
            return
        for name in names:
            try:
                with open(os.path.join(self.record_dir, name), "r",
                          encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, ValueError):
                continue
            minute = data.get("minute", name)
            for source, item in data.get("sources", {}).items():
                if source not in self._latest:
                    self._latest[source] = {
                        "minute": minute,
                        "values": item.get("values", {}),
                    }

    def latest(self, source):
        with self._lock:
            item = self._latest.get(source)
            if item is not None:
                return item
        try:
            names = sorted(
                [n for n in os.listdir(self.record_dir)
                 if n.endswith(".json") and n[0].isdigit()],
                reverse=True)
        except OSError:
            return None
        for name in names:
            try:
                with open(os.path.join(self.record_dir, name), "r",
                          encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, ValueError):
                continue
            sources = data.get("sources", {})
            if source in sources:
                return {"minute": data.get("minute", name),
                        "values": sources[source].get("values", {})}
        return None

    def minutes(self, start=None, end=None):
        """按分钟升序返回历史文件内容，minute 格式 YYYY-MM-DD HH:MM。"""
        result = []
        try:
            names = sorted(
                [n for n in os.listdir(self.record_dir)
                 if n.endswith(".json") and n[0].isdigit()])
        except OSError:
            return result
        for name in names:
            try:
                with open(os.path.join(self.record_dir, name), "r",
                          encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, ValueError):
                continue
            minute = data.get("minute")
            if not minute:
                continue
            if start is not None and minute < start:
                continue
            if end is not None and minute > end:
                break
            result.append({"minute": minute,
                           "sources": data.get("sources", {})})
        return result

    def sources(self):
        with self._lock:
            return set(self._latest.keys())


class RfidStore(object):
    def __init__(self, record_dir=DEFAULT_RECORD_DIR):
        if not os.path.isdir(record_dir):
            os.makedirs(record_dir)
        self.path = os.path.join(record_dir, "rfid_records.json")
        self._lock = threading.Lock()
        self._records = []
        self._load()

    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                self._records = data
        except (OSError, ValueError):
            self._records = []

    def _save_locked(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._records, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)

    def add(self, name):
        record = {
            "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "name": name,
        }
        with self._lock:
            self._records.append(record)
            self._save_locked()
        return record

    def page(self, start, count):
        """按时间倒序返回；start 从 1 开始。"""
        with self._lock:
            total = len(self._records)
            ordered = list(reversed(self._records))
            begin = max(0, start - 1)
            return total, ordered[begin:begin + count]
