"""In-memory request counters for dashboard metrics."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from threading import Lock


@dataclass
class RequestCounts:
    day: str
    total: int
    local: int
    remote: int


class RequestStats:
    def __init__(self) -> None:
        self._lock = Lock()
        self._day = date.today().isoformat()
        self._total = 0
        self._local = 0
        self._remote = 0

    def _rollover_if_needed(self) -> None:
        today = date.today().isoformat()
        if today != self._day:
            self._day = today
            self._total = 0
            self._local = 0
            self._remote = 0

    def increment_local(self) -> None:
        with self._lock:
            self._rollover_if_needed()
            self._total += 1
            self._local += 1

    def increment_remote(self) -> None:
        with self._lock:
            self._rollover_if_needed()
            self._total += 1
            self._remote += 1

    def snapshot(self) -> RequestCounts:
        with self._lock:
            self._rollover_if_needed()
            return RequestCounts(
                day=self._day,
                total=self._total,
                local=self._local,
                remote=self._remote,
            )


request_stats = RequestStats()
