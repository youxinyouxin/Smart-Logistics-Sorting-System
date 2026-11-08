# -*- coding: utf-8 -*-
"""IOT 采集器 DO1~DO8 控制模块（Modbus TCP，功能码 05）。

使用长连接发送线圈写命令；连接异常时自动重连并重试一次。
"""

import socket
import struct
import threading


class IotDoController(object):
    def __init__(self, ip, port, device_addr, timeout=2.0):
        self.ip = ip
        self.port = port
        self.device_addr = device_addr
        self.timeout = timeout
        self._lock = threading.Lock()
        self._states = {"DO%d" % ch: False for ch in range(1, 9)}
        self._sock = None

    def _close_socket(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def _write_coil_once(self, channel, value):
        pdu = struct.pack(">BHH", 0x05, channel, 0xFF00 if value else 0x0000)
        mbap = struct.pack(">HHHB", 1, 0, len(pdu) + 1, self.device_addr)

        if self._sock is None:
            self._sock = socket.create_connection((self.ip, self.port),
                                                  timeout=self.timeout)
            self._sock.settimeout(self.timeout)

        self._sock.sendall(mbap + pdu)
        resp = b""
        while len(resp) < 12:
            chunk = self._sock.recv(12 - len(resp))
            if not chunk:
                break
            resp += chunk

        if len(resp) != 12 or resp[7] != 0x05:
            raise IOError("DO 写入应答异常：%s" % resp.hex())
        addr = struct.unpack(">H", resp[8:10])[0]
        val = struct.unpack(">H", resp[10:12])[0]
        if addr != channel or val != (0xFF00 if value else 0x0000):
            raise IOError("DO 写入应答不匹配：%s" % resp.hex())

    def _write_coil(self, channel, value):
        last_error = None
        for _ in range(2):
            try:
                self._write_coil_once(channel, value)
                return
            except OSError as e:
                last_error = e
                self._close_socket()
        raise IOError("DO%d 写入失败：%s" % (channel, last_error))

    def set(self, channel, value):
        if not 1 <= channel <= 8:
            raise ValueError("通道号必须在 1~8 之间")
        with self._lock:
            # DO4/DO5 接同一推杆的正反控制，绝不允许同时导通
            if channel == 5 and value:
                self._write_coil(4, False)
                self._states["DO4"] = False
            elif channel == 4 and value:
                self._write_coil(5, False)
                self._states["DO5"] = False
            self._write_coil(channel, value)
            self._states["DO%d" % channel] = bool(value)

    def read_status(self):
        """采集器不支持回读线圈，这里返回本服务最近一次成功下发的状态。"""
        with self._lock:
            return dict(self._states)

    def close(self):
        with self._lock:
            self._close_socket()
