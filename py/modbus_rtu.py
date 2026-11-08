# -*- coding: utf-8 -*-
"""Modbus RTU 读寄存器基础函数及 TCP 透传通道。"""

import socket
import struct


def crc16(data):
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x0001:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc


class TcpTransport(object):
    """把 TCP 连接包装成 read/write/reset_input_buffer 接口，供 RTU 帧收发。"""

    def __init__(self, host, port, timeout=3.0):
        self.timeout = timeout
        self._sock = socket.create_connection((host, port), timeout=timeout)
        self._sock.settimeout(timeout)

    def reset_input_buffer(self):
        self._sock.setblocking(False)
        try:
            while True:
                try:
                    if not self._sock.recv(4096):
                        break
                except (BlockingIOError, socket.timeout):
                    break
        finally:
            self._sock.settimeout(self.timeout)

    def write(self, data):
        self._sock.sendall(data)

    def read(self, size):
        data = b""
        while len(data) < size:
            chunk = self._sock.recv(size - len(data))
            if not chunk:
                break
            data += chunk
        return data

    def close(self):
        try:
            self._sock.close()
        except OSError:
            pass


def read_registers(ser, device_addr, func, start, count, timeout_msg="设备无应答"):
    """通过串口读取保持寄存器，返回寄存器值列表。"""
    body = struct.pack(">BBHH", device_addr, func, start, count)
    request = body + struct.pack("<H", crc16(body))
    ser.reset_input_buffer()
    ser.write(request)

    head = ser.read(3)
    if len(head) < 3:
        raise IOError(timeout_msg + "（串口超时）")
    if head[0] != device_addr:
        raise IOError("应答设备地址不匹配：0x%02X" % head[0])
    if head[1] == (func | 0x80):
        ser.read(2)
        raise IOError("Modbus 异常应答，异常码 0x%02X" % head[2])
    if head[1] != func:
        raise IOError("功能码异常：0x%02X" % head[1])
    if head[2] != count * 2:
        raise IOError("数据长度异常：%d 字节" % head[2])

    body = ser.read(head[2] + 2)
    if len(body) != head[2] + 2:
        raise IOError("应答不完整：收到 %d 字节" % (len(head) + len(body)))
    frame = head + body
    if crc16(frame[:-2]) != (frame[-2] | (frame[-1] << 8)):
        raise IOError("CRC 校验失败：%s" % frame.hex())
    return list(struct.unpack(">%dH" % count, frame[3:3 + head[2]]))
