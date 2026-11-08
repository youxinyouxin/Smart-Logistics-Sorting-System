#!/usr/bin/env python3
import os
import subprocess
import sys

BIN = "root/servo/servo_pwm"

def main():
    args = [a for a in sys.argv[1:] if a != "--"]
    if os.geteuid() == 0:
        cmd = [BIN] + args
    else:
        cmd = ["sudo", "-n", BIN] + args
    return subprocess.run(cmd).returncode

if __name__ == "__main__":
    sys.exit(main())
