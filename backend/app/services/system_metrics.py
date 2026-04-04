"""System metrics helpers for dashboard telemetry."""
from __future__ import annotations

from pathlib import Path


def _read_int(path: Path) -> int | None:
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except Exception:
        return None


def get_memory_metrics() -> dict:
    """Read host memory stats from /proc/meminfo (Linux)."""
    info: dict[str, int] = {}
    try:
        lines = Path("/proc/meminfo").read_text(encoding="utf-8").splitlines()
        for line in lines:
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            number = value.strip().split(" ", 1)[0]
            if number.isdigit():
                info[key] = int(number) * 1024  # kB -> bytes
    except Exception:
        return {
            "total_bytes": None,
            "used_bytes": None,
            "available_bytes": None,
            "used_percent": None,
        }

    total = info.get("MemTotal")
    available = info.get("MemAvailable")
    used = None
    used_percent = None
    if total is not None and available is not None:
        used = total - available
        if total > 0:
            used_percent = (used / total) * 100

    return {
        "total_bytes": total,
        "used_bytes": used,
        "available_bytes": available,
        "used_percent": used_percent,
    }


def get_gpu_metrics() -> dict:
    """Read AMD GPU utilization when exposed by sysfs; otherwise return null fields."""
    drm_root = Path("/sys/class/drm")
    busy_percent = None
    vram_used = None
    vram_total = None

    try:
        for card in drm_root.glob("card*"):
            device = card / "device"
            if not device.exists():
                continue

            busy = _read_int(device / "gpu_busy_percent")
            used = _read_int(device / "mem_info_vram_used")
            total = _read_int(device / "mem_info_vram_total")

            if busy is not None:
                busy_percent = busy
            if used is not None:
                vram_used = used
            if total is not None:
                vram_total = total

            if busy_percent is not None or vram_used is not None or vram_total is not None:
                break
    except Exception:
        pass

    return {
        "busy_percent": busy_percent,
        "vram_used_bytes": vram_used,
        "vram_total_bytes": vram_total,
    }
