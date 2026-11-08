# -*- coding: utf-8 -*-
"""IOT 采集器 AI/DI 读取模块（纯 Modbus TCP，无 nle_library 依赖）。

寄存器：
    AI：功能码 04，起始 3501，A0/A2/A4 对应 3501/3502/3503
    DI：功能码 02，起始 1001，共 8 路
"""

import socket
import struct
import threading

AI_BASE = 3501
DI_BASE = 1001
DI_COUNT = 8


class IotAiReader(object):
    def __init__(self, ip, port, device_addr, channels, di_channels=None, timeout=1.0):
        self.ip = ip
        self.port = port
        self.device_addr = device_addr
        self.channels = tuple(channels)
        self.di_channels = tuple(di_channels or ())
        self.timeout = timeout
        self._lock = threading.Lock()
        self._sock = None
        self._tid = 0

    def _close_socket(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def _connect(self):
        self._sock = socket.create_connection((self.ip, self.port), timeout=self.timeout)
        self._sock.settimeout(self.timeout)

    def _request_once(self, func, start, count):
        if self._sock is None:
            self._connect()

        self._tid = (self._tid + 1) & 0xFFFF
        pdu = struct.pack(">BHH", func, start, count)
        mbap = struct.pack(">HHHB", self._tid, 0, len(pdu) + 1, self.device_addr)
        self._sock.sendall(mbap + pdu)

        header = b""
        while len(header) < 7:
            chunk = self._sock.recv(7 - len(header))
            if not chunk:
                raise IOError("连接已关闭")
            header += chunk
        tid, proto, length, unit = struct.unpack(">HHHB", header)
        if tid != self._tid or unit != self.device_addr:
            raise IOError("应答头不匹配")

        body = b""
        while len(body) < length - 1:
            chunk = self._sock.recv(length - 1 - len(body))
            if not chunk:
                raise IOError("连接已关闭")
            body += chunk

        if not body:
            raise IOError("空响应")
        if body[0] == (func | 0x80):
            raise IOError("Modbus 异常码 0x%02X" % body[1])
        if body[0] != func or len(body) < 2:
            raise IOError("功能码异常")
        byte_count = body[1]
        if len(body) < 2 + byte_count:
            raise IOError("数据长度异常")
        return body[2:2 + byte_count]

    def _request(self, func, start, count):
        last_error = None
        for _ in range(2):
            try:
                return self._request_once(func, start, count)
            except OSError as e:
                last_error = e
                self._close_socket()
        raise IOError("Modbus 读取失败：%s" % last_error)

    def _read_ai(self):
        data = self._request(0x04, AI_BASE, 3)
        if len(data) != 6:
            raise IOError("AI 数据长度异常")
        return struct.unpack(">3H", data)

    def _read_di(self):
        data = self._request(0x02, DI_BASE, DI_COUNT)
        if len(data) != 1:
            raise IOError("DI 数据长度异常")
        bits = []
        for index in range(DI_COUNT):
            bits.append(bool((data[0] >> index) & 0x01))
        return bits

    def read_all(self):
        """读取 AI 通道和 DI，返回 {通道号: 原始值}，DI 放在 'di' 键。"""
        with self._lock:
            values = {}
            ai = None
            if self.channels:
                try:
                    ai = self._read_ai()
                except OSError:
                    ai = None

            for channel in self.channels:
                index = channel // 2
                if ai is not None and 0 <= index < len(ai):
                    values[channel] = ai[index]
                else:
                    values[channel] = None

            if self.di_channels:
                try:
                    di = self._read_di()
                except OSError:
                    di = None
                if di is None:
                    values["di"] = None
                else:
                    values["di"] = {
                        channel: di[channel]
                        for channel in self.di_channels
                        if channel < len(di)
                    }
            return values

    def close(self):
        with self._lock:
            self._close_socket()
