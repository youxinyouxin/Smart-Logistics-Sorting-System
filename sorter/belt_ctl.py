#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""传送带电机控制（gpiozero + LGPIOFactory，按官方文档写法）

用法:
  python3 belt_ctl.py on             # 置高（随后退出 → 引脚会被复位，仅适合自检）
  python3 belt_ctl.py off
  python3 belt_ctl.py test           # 自检：转3s/停2s ×3
  python3 belt_ctl.py daemon         # 常驻模式：从 stdin 读 on/off/test/quit 命令，
                                     # 进程存活期间一直持有引脚、保持电平（主程序用这个）

选项:
  --gpio N         GPIO 编号（默认 70，排针第 7 脚；33=第37脚）
  --active-high    高电平=运行（默认）
  --active-low     低电平=运行
  test 选项: --cycles N  --run-sec S  --stop-sec S
"""

import argparse
import sys
import time

from gpiozero import Device, DigitalOutputDevice
from gpiozero.pins.lgpio import LGPIOFactory

Device.pin_factory = LGPIOFactory(chip=0)


def run_test(motor, cycles, run_sec, stop_sec):
    for i in range(cycles):
        print(f"[{i + 1}/{cycles}] HIGH {run_sec:.1f}s", flush=True)
        motor.on()
        time.sleep(run_sec)
        print(f"[{i + 1}/{cycles}] LOW  {stop_sec:.1f}s", flush=True)
        motor.off()
        time.sleep(stop_sec)
    print("test done", flush=True)


def main():
    ap = argparse.ArgumentParser(description="传送带电机控制")
    ap.add_argument("cmd", choices=["on", "off", "test", "daemon"])
    ap.add_argument("--gpio", type=int, default=70)
    ap.add_argument("--active-high", dest="active_high", action="store_true", default=True)
    ap.add_argument("--active-low", dest="active_high", action="store_false")
    ap.add_argument("--cycles", type=int, default=3)
    ap.add_argument("--run-sec", type=float, default=3.0)
    ap.add_argument("--stop-sec", type=float, default=2.0)
    args = ap.parse_args()

    motor = DigitalOutputDevice(args.gpio, active_high=args.active_high, initial_value=False)
    try:
        if args.cmd == "on":
            motor.on()
            print(f"belt on (GPIO{args.gpio})", flush=True)
            time.sleep(0.2)   # 给主程序留出发送后续命令的时间窗（一次性模式电平随后会释放）
        elif args.cmd == "off":
            motor.off()
            print(f"belt off (GPIO{args.gpio})", flush=True)
            time.sleep(0.2)
        elif args.cmd == "test":
            run_test(motor, args.cycles, args.run_sec, args.stop_sec)
        else:  # daemon：常驻，保持引脚电平
            mode = "低电平运行" if not args.active_high else "高电平运行"
            print(f"belt daemon ready (GPIO{args.gpio}, {mode})", flush=True)
            for line in sys.stdin:
                cmd = line.strip().lower()
                if cmd == "on":
                    motor.on()
                    print("ok on", flush=True)
                elif cmd == "off":
                    motor.off()
                    print("ok off", flush=True)
                elif cmd == "test":
                    run_test(motor, args.cycles, args.run_sec, args.stop_sec)
                    print("ok test", flush=True)
                elif cmd in ("quit", "exit"):
                    break
            motor.off()
            print("daemon exit", flush=True)
        return 0
    finally:
        motor.off()
        motor.close()


if __name__ == "__main__":
    sys.exit(main())
