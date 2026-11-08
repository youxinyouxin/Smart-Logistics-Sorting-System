# -*- coding: utf-8 -*-
"""多合一传感器读取模块（RS485 经 USR-TCP232-410s 透明传输，Modbus RTU over TCP）。

说明书寄存器：
    功能码 03，0x0000~0x0004：CO2(ppm)、TVOC(ppb)、温度(℃)、湿度(%)、人体(0/1)
    功能码 04，0x0065~0x0066：PM2.5(ug/m3)、大气压(0.1hPa)
"""

from modbus_rtu import TcpTransport, read_registers


class MultiInOneReader(object):
    def __init__(self, ip, port, device_addr, timeout=3.0):
        self.device_addr = device_addr
        self._transport = TcpTransport(ip, port, timeout)

    def read_all(self):
        """读取多合一传感器全部要素。"""
        air = read_registers(self._transport, self.device_addr, 0x03, 0x0000, 5,
                             "多合一传感器无应答")
        env = read_registers(self._transport, self.device_addr, 0x04, 0x0065, 2,
                             "多合一传感器无应答")
        return {
            "co2": air[0],
            "tvoc": air[1],
            "temperature": air[2],
            "humidity": air[3],
            "body": bool(air[4]),
            "pm2_5": env[0],
            "pressure_hpa": round(env[1] / 10.0, 1),
        }

    def close(self):
        self._transport.close()
