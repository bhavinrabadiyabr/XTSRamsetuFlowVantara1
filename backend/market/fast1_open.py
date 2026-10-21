"""
09:20 one-minute spot OPEN for the 1 min Fast desk.

The line is that bar's open, not the close and not OHLC4. The open is locked
the first time the 09:20 bar exists, including while that candle is still
forming. Later bars cannot move it. Before 09:20 there is no line.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable

from market.dada_range import IST, OhlcBar

NIFTY = "NIFTY"
SENSEX = "SENSEX"
INSTRUMENTS: dict[str, tuple[int, int]] = {
    NIFTY: (1, 26000),
    SENSEX: (11, 26065),
}
OPEN_MINUTE = 920
MISS_SECONDS = 1.0

_LOCK = threading.Lock()
_STORE: dict[str, dict[str, Any]] = {}
_LOADED = False
_DISK = Path(__file__).resolve().parent.parent / "cache" / "fast1_open.json"


def _normalize(underlying: str) -> str:
    return str(underlying or "").strip().upper()


def _day_key(underlying: str, day: str) -> str:
    return f"{underlying}|{day}"


def _miss_key(underlying: str, day: str) -> str:
    return f"miss:{underlying}|{day}"


def _ensure_loaded() -> None:
    global _LOADED
    if _LOADED:
        return
    _LOADED = True
    try:
        raw = json.loads(_DISK.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(raw, dict):
        return
    for key, row in raw.items():
        if isinstance(key, str) and isinstance(row, dict) and row.get("spot"):
            _STORE.setdefault(key, row)


def _persist() -> None:
    kept = {
        key: row
        for key, row in _STORE.items()
        if isinstance(row, dict) and row.get("spot") and not str(key).startswith("miss:")
    }
    try:
        _DISK.parent.mkdir(parents=True, exist_ok=True)
        _DISK.write_text(json.dumps(kept), encoding="utf-8")
    except OSError:
        return


def _public(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "pending": False,
        "underlying": row.get("underlying"),
        "sessionDate": row.get("sessionDate"),
        "spot": row.get("spot"),
        "source": "09:20-open",
        "minute": "09:20",
        "error": None,
    }


def _pending(underlying: str, day: str, error: str | None = None) -> dict[str, Any]:
    return {
        "ok": error is None,
        "pending": True,
        "underlying": underlying,
        "sessionDate": day,
        "spot": None,
        "source": None,
        "minute": None,
        "error": error,
    }


def open_from_bars(bars: list[OhlcBar], session: date) -> float | None:
    """Open of the 09:20 minute on `session`. Close, high, low, and other days are ignored."""
    want = int(session.strftime("%Y%m%d")) * 10000 + OPEN_MINUTE
    for bar in bars or []:
        if int(getattr(bar, "minute_key", 0) or 0) != want:
            continue
        try:
            px = float(bar.open or 0)
        except (TypeError, ValueError):
            px = 0.0
        if px > 0:
            return round(px + 1e-9, 2)
    return None


def _default_fetch(underlying: str, now: datetime) -> list[OhlcBar]:
    from market.dada_range import fetch_range_1m_bars
    from market.nifty_vwap import _xts_client

    segment, instrument_id = INSTRUMENTS[underlying]
    start = now.astimezone(IST).replace(hour=9, minute=20, second=0, microsecond=0)
    return fetch_range_1m_bars(
        _xts_client(),
        exchange_segment=segment,
        exchange_instrument_id=instrument_id,
        start=start,
        end=start,
    )


def get_open(
    underlying: str,
    *,
    now: datetime | None = None,
    store: dict[str, dict[str, Any]] | None = None,
    fetch: Callable[[str, datetime], list[OhlcBar]] | None = None,
) -> dict[str, Any]:
    """Today's locked 09:20 open. The first print wins for the session."""
    name = _normalize(underlying)
    now = (now or datetime.now(IST)).astimezone(IST)
    if name not in INSTRUMENTS:
        return {
            "ok": False,
            "pending": False,
            "error": "1 min Fast trades NIFTY or SENSEX.",
            "spot": None,
            "source": None,
        }
    day = now.date().isoformat()
    if now.weekday() >= 5:
        return _pending(name, day, "Cash market is closed.")
    own = store is None
    with _LOCK:
        if own:
            _ensure_loaded()
        box = _STORE if own else store
        existing = box.get(_day_key(name, day))
        if isinstance(existing, dict) and existing.get("spot"):
            return _public(existing)
        if (now.hour, now.minute) < (9, 20):
            return _pending(name, day)
        miss = box.get(_miss_key(name, day))
        if isinstance(miss, dict):
            age = time.monotonic() - float(miss.get("at") or 0)
            if age < MISS_SECONDS and isinstance(miss.get("payload"), dict):
                return miss["payload"]
    try:
        bars = (fetch or _default_fetch)(name, now)
        px = open_from_bars(bars, now.date())
    except Exception as exc:
        payload = _pending(name, day, str(exc) or "09:20 open is not in yet.")
        payload["ok"] = False
        with _LOCK:
            box = _STORE if own else store
            assert box is not None
            box[_miss_key(name, day)] = {"at": time.monotonic(), "payload": payload}
        return payload
    if px is None:
        payload = _pending(name, day, "09:20 open is not in yet.")
        payload["ok"] = False
        with _LOCK:
            box = _STORE if own else store
            assert box is not None
            box[_miss_key(name, day)] = {"at": time.monotonic(), "payload": payload}
        return payload
    row = {
        "underlying": name,
        "sessionDate": day,
        "spot": px,
        "source": "09:20-open",
        "minute": "09:20",
    }
    with _LOCK:
        box = _STORE if own else store
        assert box is not None
        key = _day_key(name, day)
        current = box.get(key)
        if isinstance(current, dict) and current.get("spot"):
            return _public(current)
        box[key] = row
        box.pop(_miss_key(name, day), None)
        if own:
            _persist()
    return _public(row)
