#!/bin/sh
export XDG_RUNTIME_DIR=/run/user/1000
export WAYLAND_DISPLAY=wayland-0
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
export QT_QPA_PLATFORM=wayland
cd /root/img
exec ./venv/bin/python -u yolo_face_display.py "$@"
