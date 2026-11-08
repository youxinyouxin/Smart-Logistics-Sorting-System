# -*- coding: utf-8 -*-
"""烟雾报警控制：DI=1 开报警灯，DI 归 0 后延时关闭。"""

import threading
import time


class SmokeAlarm(object):
    def __init__(self, do, do_channel=3, hold_seconds=2.0):
        self.do = do
        self.do_channel = do_channel
        self.hold_seconds = hold_seconds
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._smoke = False
        self._clear_since = None
        self._output_on = None
        self._last_error = 0.0
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def update(self, smoke):
        """更新烟雾状态；None 表示本次未读到，保持现有状态。"""
        if smoke is None:
            return
        with self._lock:
            if smoke:
                self._smoke = True
                self._clear_since = None
            elif self._smoke:
                self._smoke = False
                self._clear_since = time.monotonic()
        self._wake.set()

    def stop(self):
        self._stop.set()
        self._wake.set()

    def join(self, timeout=3.0):
        if self._thread is not None:
            self._thread.join(timeout)

    def _run(self):
        while not self._stop.is_set():
            with self._lock:
                smoke = self._smoke
                clear_since = self._clear_since

            if smoke:
                want_on = True
            elif clear_since is not None:
                want_on = (time.monotonic() - clear_since) < self.hold_seconds
            else:
                want_on = False

            if want_on != self._output_on:
                try:
                    self.do.set(self.do_channel, want_on)
                    self._output_on = want_on
                except Exception as e:
                    if time.monotonic() - self._last_error >= 5:
                        print("DO%d 报警灯控制失败：%s" % (self.do_channel, e))
                        self._last_error = time.monotonic()

            self._wake.wait(0.1)
            self._wake.clear()

        try:
            self.do.set(self.do_channel, False)
        except Exception:
            pass
