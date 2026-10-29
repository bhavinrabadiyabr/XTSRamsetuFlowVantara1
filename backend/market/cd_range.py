"""
CD desk range: HIGH / LOW / MID from the last N closed TF-minute Sensex bars.

The forming candle is never included. A live wick does not move HIGH or LOW.
Bars are session-aligned from 09:15 IST. The first entry is 09:15 + N × TF.
"""

from __future__ import annotations

import re
import threading
import time
from datetime import datetime
from typing import Any, Callable

from market.dada_range import (
    IST,
    OhlcBar,
    _minute_key_to_dt,
    aggregate_1m_to_tf,
    closed_tf_bars,
    fetch_session_1m_bars,
)

SENSEX_SEGMENT = 11
SENSEX_INSTRUMENT_ID = 26065
CANDLES = 4
MIN_GAP = 50.0
TF_MINUTES = 15
CACHE_SECONDS = 2.0

_LOCK = threading.Lock()
_CACHE: dict[str, Any] = {"at": 0.0, "day": "", "payload": None}


def parse_range_params(tf: str, candles: str, min_gap: str) -> dict[str, Any] | None:
    """Saved CD range inputs. Whole minutes and candles, gap from 0 to 5000."""
    tf_text = str(tf or "").strip()
    candle_text = str(candles or "").strip()
    gap_text = str(min_gap or "").strip()
    if not re.fullmatch(r"\d+", tf_text) or not re.fullmatch(r"\d+", candle_text):
        return None
    if not re.fullmatch(r"\d+(\.\d+)?", gap_text):
        return None
    tf_i = int(tf_text)
    n = int(candle_text)
    gap = float(gap_text)
    if not (1 <= tf_i <= 60 and 1 <= n <= 20 and 0 <= gap <= 5000):
        return None
    return {"tf_minutes": tf_i, "candles": n, "min_gap": gap}


def first_entry_label(candles: int, tf_minutes: int) -> str:
    total = 9 * 60 + 15 + int(candles) * int(tf_minutes)
    days, mins = divmod(total, 24 * 60)
    hh, mm = divmod(mins, 60)
    clock = f"{hh:02d}:{mm:02d}"
    return f"{clock} +{days}d" if days else clock


def _label(minute_key: int) -> str:
    text = str(int(minute_key))
    if len(text) != 12:
        return text
    return f"{text[8:10]}:{text[10:12]}"


def _today_bars(bars: list[OhlcBar], now: datetime) -> list[OhlcBar]:
    day = now.astimezone(IST).date()
    out: list[OhlcBar] = []
    for bar in bars or []:
        dt = _minute_key_to_dt(bar.minute_key)
        if dt is not None and dt.date() == day:
            out.append(bar)
    return out


def build_cd_range(
    bars_1m: list[OhlcBar],
    now: datetime | None = None,
    *,
    candles: int = CANDLES,
    min_gap: float = MIN_GAP,
    tf_minutes: int = TF_MINUTES,
) -> dict[str, Any]:
    """Last `candles` fully closed TF bars. The live bar is left out."""
    now = (now or datetime.now(IST)).astimezone(IST)
    tf = max(1, int(tf_minutes))
    n = max(1, int(candles))
    closed = closed_tf_bars(aggregate_1m_to_tf(_today_bars(bars_1m, now), tf), tf, now)
    window = closed[-n:] if len(closed) >= n else []
    ready = len(window) == n
    high = max((bar.high for bar in window), default=0.0) if ready else 0.0
    low = min((bar.low for bar in window), default=0.0) if ready else 0.0
    gap = high - low if ready else 0.0
    tradable = ready and gap + 1e-9 >= float(min_gap)
    first_entry = first_entry_label(n, tf)
    return {
        "ok": True,
        "ready": ready,
        "tradable": tradable,
        "high": round(high, 2) if ready else None,
        "low": round(low, 2) if ready else None,
        "mid": round((high + low) / 2, 2) if ready else None,
        "gap": round(gap, 2) if ready else None,
        "closedCount": len(closed),
        "candles": n,
        "tfMinutes": tf,
        "minGap": float(min_gap),
        "firstEntry": first_entry,
        "sessionDate": now.date().isoformat(),
        "firstBar": _label(window[0].minute_key) if ready else None,
        "lastBar": _label(window[-1].minute_key) if ready else None,
        "error": None if ready else f"{n} closed {tf}-minute bars are required. The first entry is {first_entry}.",
    }


_MD_CLIENT: Callable[[], Any] | None = None


def set_md_client(getter: Callable[[], Any] | None) -> None:
    """XTS market-data client used to fetch Sensex bars. Set from the API route."""
    global _MD_CLIENT
    _MD_CLIENT = getter


def _xts_client() -> Any:
    if _MD_CLIENT is None:
        raise RuntimeError("XTS history is not configured")
    client = _MD_CLIENT()
    if client is None:
        raise RuntimeError("XTS history is not configured")
    return client


def _fetch_default() -> list[OhlcBar]:
    return fetch_session_1m_bars(
        _xts_client(),
        exchange_segment=SENSEX_SEGMENT,
        exchange_instrument_id=SENSEX_INSTRUMENT_ID,
    )


def get_range(
    *,
    now: datetime | None = None,
    bars: list[OhlcBar] | None = None,
    tf_minutes: int = TF_MINUTES,
    candles: int = CANDLES,
    min_gap: float = MIN_GAP,
) -> dict[str, Any]:
    """Today's rolling range. Pass `bars` to skip the broker fetch."""
    now = (now or datetime.now(IST)).astimezone(IST)
    tf = int(tf_minutes)
    n = int(candles)
    gap = float(min_gap)
    if bars is not None:
        return build_cd_range(bars, now, tf_minutes=tf, candles=n, min_gap=gap)
    if now.weekday() >= 5:
        payload = build_cd_range([], now, tf_minutes=tf, candles=n, min_gap=gap)
        payload["error"] = "Cash market is closed."
        return payload
    day = now.date().isoformat()
    cache_key = f"{day}|{tf}|{n}|{gap}"
    with _LOCK:
        cached = _CACHE.get("payload")
        age = time.monotonic() - float(_CACHE.get("at") or 0)
        if _CACHE.get("day") == cache_key and isinstance(cached, dict) and age < CACHE_SECONDS:
            return cached
    try:
        fetched = _fetch_default()
    except Exception as exc:
        return {
            "ok": False,
            "ready": False,
            "tradable": False,
            "high": None,
            "low": None,
            "mid": None,
            "gap": None,
            "closedCount": 0,
            "sessionDate": day,
            "firstBar": None,
            "lastBar": None,
            "error": str(exc) or "Sensex range is not in yet.",
        }
    payload = build_cd_range(fetched, now, tf_minutes=tf, candles=n, min_gap=gap)
    with _LOCK:
        _CACHE["at"] = time.monotonic()
        _CACHE["day"] = cache_key
        _CACHE["payload"] = payload
    return payload
