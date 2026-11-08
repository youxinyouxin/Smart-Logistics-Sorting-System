# -*- coding: utf-8 -*-
"""UHF 超高频读卡器与工厂大门控制。

DO 映射：
    DO4 推出推杆（关门）   DO5 收回推杆（开门）
    DO6 绿灯               DO7 黄灯               DO8 红灯
注意：DO4 与 DO5 绝不允许同时打开。
"""

import socket
import time
import threading

DO_CLOSE = 4
DO_OPEN = 5
DO_GREEN = 6
DO_YELLOW = 7
DO_RED = 8

RECORDS_PER_POLL = 5
TAG_RECORD_SIZE = 24
CLEAR_RECORD_SIZE = 8


class UhfReader(object):
    def __init__(self, ip, port, command, timeout=3.0):
        self.ip = ip
        self.port = port
        self.command = bytes.fromhex(command)
        self.timeout = timeout
        self._sock = None

    def _connect(self):
        self._sock = socket.create_connection((self.ip, self.port), timeout=self.timeout)
        self._sock.settimeout(self.timeout)

    def close(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    @staticmethod
    def _classify(frame):
        if len(frame) < 9 or frame[0:4] != b"\xFF\x55\x00\x00" or frame[4:6] != b"\x83\x0A":
            return None
        length = frame[6]
        if len(frame) != 7 + length + 2:
            return None

        payload = frame[7:7 + length]
        tag_count = 0
        clear_count = 0
        offset = 0
        while offset < len(payload):
            if payload[offset:offset + 2] == b"\xBB\x02":
                end = offset + TAG_RECORD_SIZE
                if end > len(payload) or payload[end - 1] != 0x7E:
                    return None
                tag_count += 1
                offset = end
            elif payload[offset:offset + 2] == b"\xBB\x01":
                end = offset + CLEAR_RECORD_SIZE
                if end > len(payload) or payload[end - 1] != 0x7E:
                    return None
                clear_count += 1
                offset = end
            else:
                return None

        if tag_count + clear_count != RECORDS_PER_POLL:
            return None
        if tag_count == RECORDS_PER_POLL:
            return "tag"
        if clear_count == RECORDS_PER_POLL:
            return "clear"
        return "mixed"

    def read_poll(self):
        """发送一次 5 轮询指令，返回 tag / clear / mixed / None。"""
        if self._sock is None:
            self._connect()
        data = b""
        try:
            self._sock.sendall(self.command)
            while len(data) < 7:
                chunk = self._sock.recv(1024)
                if not chunk:
                    self.close()
                    return None
                data += chunk
            total = 7 + data[6] + 2
            while len(data) < total:
                chunk = self._sock.recv(1024)
                if not chunk:
                    self.close()
                    return None
                data += chunk
        except socket.timeout:
            self.close()  # 超时即重连，避免迟到的旧应答影响下一次
            return None
        except OSError:
            self.close()
            return None

        result = self._classify(data[:total])
        if result is None:
            self.close()  # 非本指令的帧，关闭连接重新同步
        return result


class GateController(object):
    def __init__(self, do, reader, open_seconds=13, green_seconds=3,
                 close_seconds=10, poll_interval=1.0,
                 tag_confirm=2, clear_confirm=2, start_armed=False,
                 on_card=None):
        self.do = do
        self.reader = reader
        self.open_seconds = open_seconds
        self.green_seconds = green_seconds
        self.close_seconds = close_seconds
        self.poll_interval = poll_interval
        self.tag_confirm = tag_confirm
        self.clear_confirm = clear_confirm
        self.start_armed = start_armed
        self.on_card = on_card
        self._stop = threading.Event()

    def stop(self):
        self._stop.set()

    def _set(self, channel, value, retries=3, ignore_stop=False):
        last_error = None
        for attempt in range(retries):
            try:
                self.do.set(channel, value)
                return True
            except Exception as e:
                last_error = e
                if attempt == retries - 1:
                    break
                if ignore_stop:
                    time.sleep(0.2)
                elif self._stop.wait(0.2):
                    return False
        print("DO%d 控制失败：%s" % (channel, last_error))
        return False

    def _safe_stop(self):
        # 先断开两个推杆输出，避免 DO4/DO5 同时导通
        self._set(DO_CLOSE, False, retries=3, ignore_stop=True)
        self._set(DO_OPEN, False, retries=3, ignore_stop=True)
        self._set(DO_YELLOW, False, retries=2, ignore_stop=True)
        self._set(DO_GREEN, False, retries=2, ignore_stop=True)
        self._set(DO_RED, False, retries=2, ignore_stop=True)

    def _fault(self, message):
        print(message)
        self._stop.set()
        self._safe_stop()
        self._set(DO_RED, True, retries=2, ignore_stop=True)

    def _run_cycle(self):
        print("检测到标签，开始开门")
        # 安全互锁：开门前必须确认关门输出已关闭
        if not self._set(DO_CLOSE, False):
            self._fault("无法确认 DO4 关闭，取消开门")
            return

        self._set(DO_RED, False)
        self._set(DO_YELLOW, True)
        if not self._set(DO_OPEN, True):
            self._set(DO_YELLOW, False)
            self._set(DO_RED, True)
            return

        if self._stop.wait(self.open_seconds):
            self._safe_stop()
            return

        # 先确认 DO5 已关闭，再切换绿灯
        if not self._set(DO_OPEN, False):
            self._fault("无法确认 DO5 关闭，停止开门流程")
            return
        self._set(DO_YELLOW, False)
        self._set(DO_GREEN, True)

        if self._stop.wait(self.green_seconds):
            self._safe_stop()
            return

        # 安全互锁：关门前再次确认开门输出已关闭
        if not self._set(DO_OPEN, False):
            self._fault("无法确认 DO5 关闭，取消关门")
            return

        self._set(DO_YELLOW, False)  # 防止之前黄灯关闭失败后残留
        self._set(DO_GREEN, False)
        self._set(DO_RED, True)
        if not self._set(DO_CLOSE, True):
            self._fault("DO4 开启失败，停止读卡")
            return

        if self._stop.wait(self.close_seconds):
            self._safe_stop()
            return

        if not self._set(DO_CLOSE, False):
            self._fault("无法确认 DO4 关闭，停止读卡")
            return
        print("大门已关闭，等待读卡器清空")

    def run(self):
        # 初始化：两个推杆输出关闭，红灯常亮
        self._set(DO_OPEN, False)
        self._set(DO_CLOSE, False)
        self._set(DO_YELLOW, False)
        self._set(DO_GREEN, False)
        self._set(DO_RED, True)

        armed = self.start_armed
        tag_count = 0
        clear_count = 0
        last_result = "__init__"

        while not self._stop.is_set():
            start = time.monotonic()
            result = self.reader.read_poll()
            if result != last_result:
                print("读卡器状态：%s" % result)
                last_result = result

            if result == "tag":
                clear_count = 0
                if armed:
                    tag_count += 1
                    if tag_count >= self.tag_confirm:
                        if self.on_card is not None:
                            try:
                                self.on_card()
                            except Exception as e:
                                print("打卡记录失败：%s" % e)
                        self._run_cycle()
                        if self._stop.is_set():
                            break
                        armed = False
                        tag_count = 0
                        clear_count = 0
                        continue
                else:
                    tag_count = 0
            elif result == "clear":
                tag_count = 0
                clear_count += 1
                if not armed and clear_count >= self.clear_confirm:
                    armed = True
                    clear_count = 0
                    print("读卡器已清空，恢复检测")
            else:  # mixed / None
                tag_count = 0
                clear_count = 0

            delay = self.poll_interval - (time.monotonic() - start)
            if delay > 0:
                self._stop.wait(delay)

        self._safe_stop()
        self.reader.close()
