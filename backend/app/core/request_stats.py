"""In-memory request counters for dashboard metrics."""
from __future__ import annotations

from collections import defaultdict
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
        # Per-conversation request counters (conversation_id -> count)
        self._conversation_requests: dict[str, int] = defaultdict(int)
        # Per-conversation token counters (conversation_id -> total_tokens)
        self._conversation_tokens: dict[str, int] = defaultdict(int)

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

    def increment_conversation(self, conversation_id: str, tokens: int = 0) -> None:
        """Track per-conversation request count and token usage."""
        if not conversation_id:
            return
        with self._lock:
            self._conversation_requests[conversation_id] += 1
            self._conversation_tokens[conversation_id] += tokens

    def get_conversation_usage(self, conversation_id: str) -> tuple[int, int]:
        """Return (request_count, total_tokens) for a conversation."""
        with self._lock:
            return (
                self._conversation_requests.get(conversation_id, 0),
                self._conversation_tokens.get(conversation_id, 0),
            )


request_stats = RequestStats()
