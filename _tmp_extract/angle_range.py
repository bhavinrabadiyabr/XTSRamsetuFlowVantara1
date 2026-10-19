"""
Angle strategy: last N fully closed OHLC bars (HIGH/LOW/MID/GAP) for spot.

XTS multi-TF compression is unreliable for index spot (wrong bar open times +
occasional price-scale drift vs touchline). We always fetch 1-minute OHLC,
rescale to live spot LTP, then aggregate into session-aligned TF candles
(09:15, 09:30, …) — same boundaries Angel / NSE–BSE charts use.
"""

from __future__ import annotations

import json
import logging
import re
import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

_log = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")

# UI label → minutes per candle (session-aligned from 09:15)
TF_MINUTES: dict[str, int] = {
    "1m": 1,
    "3m": 3,
    "5m": 5,
    "15m": 15,
    "30m": 30,
}


@dataclass(frozen=True)
class OhlcBar:
    """Bar keyed by open time as YYYYMMDDHHMM (IST)."""

    minute_key: int
    open: float
    high: float
    low: float
    close: float


def _session_start_ist(now: datetime | None = None) -> datetime:
    now = (now or datetime.now(IST)).astimezone(IST)
    return now.replace(hour=9, minute=15, second=0, microsecond=0)


def _session_end_ist(now: datetime | None = None) -> datetime:
    now = (now or datetime.now(IST)).astimezone(IST)
    return now.replace(hour=15, minute=30, second=0, microsecond=0)


def _format_xts_time(dt: datetime) -> str:
    return dt.astimezone(IST).strftime("%b %d %Y %H%M%S")


def _minute_key_to_dt(minute_key: int) -> datetime | None:
    s = str(int(minute_key))
    if len(s) != 12:
        return None
    try:
        return datetime(
            int(s[0:4]),
            int(s[4:6]),
            int(s[6:8]),
            int(s[8:10]),
            int(s[10:12]),
            tzinfo=IST,
        )
    except Exception:
        return None


def _dt_to_minute_key(dt: datetime) -> int:
    return int(dt.astimezone(IST).strftime("%Y%m%d%H%M"))


def _ohlc_epoch_to_minute_key(ts: float) -> int:
    """XTS OHLC BarTime is IST wall-clock stored as UTC epoch (vendor quirk)."""
    dt = datetime.utcfromtimestamp(float(ts))
    return int(dt.strftime("%Y%m%d%H%M"))


def _parse_pipe_ohlc_line(line: str) -> OhlcBar | None:
    line = line.strip().strip(",")
    if not line:
        return None
    parts = [p.strip() for p in line.split("|")]
    if len(parts) < 5:
        return None
    try:
        ts_raw = parts[0].split()[0]
        ts = float(ts_raw)
        o = float(parts[1].replace(",", ""))
        h = float(parts[2].replace(",", ""))
        lo = float(parts[3].replace(",", ""))
        c = float(parts[4].replace(",", ""))
    except Exception:
        return None
    if not (h > 0 and lo > 0 and c > 0):
        return None
    if h < lo:
        h, lo = lo, h
    return OhlcBar(_ohlc_epoch_to_minute_key(ts), o, h, lo, c)


def _parse_pipe_ohlc_blob(text: str) -> list[OhlcBar]:
    out: list[OhlcBar] = []
    for segment in re.split(r"[,]+", text):
        bar = _parse_pipe_ohlc_line(segment)
        if bar is not None:
            out.append(bar)
    return out


def _candle_from_dict(obj: dict[str, Any]) -> OhlcBar | None:
    def f(*keys: str) -> float | None:
        for k in keys:
            if k in obj and obj[k] is not None:
                try:
                    return float(obj[k])
                except Exception:
                    continue
        return None

    h = f("High", "high", "h")
    lo = f("Low", "low", "l")
    c = f("Close", "close", "c")
    o = f("Open", "open", "o") or c
    if h is None or lo is None or c is None or not (h > 0 and lo > 0 and c > 0):
        return None
    if h < lo:
        h, lo = lo, h
    ts: float | None = None
    for k, v in obj.items():
        kn = str(k).lower()
        if "timestamp" in kn or "bartime" in kn or kn in ("t", "time"):
            if isinstance(v, (int, float)):
                ts = float(v)
                break
            if isinstance(v, str):
                m = re.search(r"(\d{9,11})", v)
                if m:
                    ts = float(m.group(1))
                    break
    if ts is None:
        return None
    return OhlcBar(_ohlc_epoch_to_minute_key(ts), float(o or c), float(h), float(lo), float(c))


def parse_ohlc_full(raw: Any) -> list[OhlcBar]:
    """Extract OHLC bars (oldest first) from XTS OHLC JSON / pipe text."""
    bars: list[OhlcBar] = []
    seen: set[int] = set()

    def add(bar: OhlcBar | None) -> None:
        if bar is None or bar.minute_key <= 0:
            return
        if bar.minute_key in seen:
            return
        seen.add(bar.minute_key)
        bars.append(bar)

    def visit(obj: Any, depth: int = 0) -> None:
        if depth > 16 or obj is None:
            return
        if isinstance(obj, str):
            s = obj.strip()
            if not s:
                return
            if s[0] in "{[":
                try:
                    visit(json.loads(s), depth + 1)
                except Exception:
                    pass
                return
            if "|" in s and ("," in s or re.search(r"\d\|\d", s)):
                for bar in _parse_pipe_ohlc_blob(s):
                    add(bar)
                return
            for line in re.split(r"[\r\n]+", s):
                add(_parse_pipe_ohlc_line(line))
            return
        if isinstance(obj, dict):
            dr = obj.get("dataReponse") or obj.get("dataResponse") or obj.get("DataResponse")
            if isinstance(dr, str) and "|" in dr:
                for bar in _parse_pipe_ohlc_blob(dr):
                    add(bar)
            if any(k in obj for k in ("High", "high", "h", "Close", "close", "c")):
                add(_candle_from_dict(obj))
                return
            for k in ("dataReponse", "dataResponse", "DataResponse", "result", "Result", "listCandles", "candles"):
                if k in obj and not (
                    k in ("dataReponse", "dataResponse", "DataResponse") and isinstance(obj.get(k), str)
                ):
                    visit(obj[k], depth + 1)
            for v in obj.values():
                if isinstance(v, (dict, list, str)):
                    visit(v, depth + 1)
            return
        if isinstance(obj, list):
            for item in obj:
                visit(item, depth + 1)

    visit(raw)
    bars.sort(key=lambda b: b.minute_key)
    return bars


def _rescale_bars_to_ltp(bars: list[OhlcBar], live_ltp: float) -> list[OhlcBar]:
    """Match ema21: XTS OHLC sometimes drifts in absolute scale vs touchline LTP."""
    if not bars or not (live_ltp > 0):
        return bars
    recent = [b.close for b in bars[-24:] if b.close > 0]
    if not recent:
        return bars
    med = float(statistics.median(recent))
    if med <= 0:
        return bars
    ratio = med / float(live_ltp)
    # Already on the same scale
    if 0.985 <= ratio <= 1.015:
        return bars
    factor = float(live_ltp) / med
    if not (0.02 <= factor <= 50.0):
        return bars
    _log.info(
        "angle ohlc rescale med=%.2f ltp=%.2f factor=%.6f bars=%s",
        med,
        live_ltp,
        factor,
        len(bars),
    )
    return [
        OhlcBar(
            b.minute_key,
            float(b.open) * factor,
            float(b.high) * factor,
            float(b.low) * factor,
            float(b.close) * factor,
        )
        for b in bars
    ]


def _tf_bucket_open(dt: datetime, tf_minutes: int) -> datetime | None:
    """Session-aligned bucket open (09:15-based), or None if outside session."""
    dt = dt.astimezone(IST).replace(second=0, microsecond=0)
    start = _session_start_ist(dt)
    end = _session_end_ist(dt)
    if dt < start or dt >= end:
        return None
    elapsed = int((dt - start).total_seconds() // 60)
    bucket = (elapsed // int(tf_minutes)) * int(tf_minutes)
    return start + timedelta(minutes=bucket)


def aggregate_1m_to_tf(bars_1m: list[OhlcBar], tf_minutes: int) -> list[OhlcBar]:
    """Build TF candles from 1m bars; open time = session-aligned bucket start."""
    if tf_minutes <= 1:
        return list(bars_1m)

    buckets: dict[int, OhlcBar] = {}
    for b in bars_1m:
        dt = _minute_key_to_dt(b.minute_key)
        if dt is None:
            continue
        open_dt = _tf_bucket_open(dt, tf_minutes)
        if open_dt is None:
            continue
        key = _dt_to_minute_key(open_dt)
        cur = buckets.get(key)
        if cur is None:
            buckets[key] = OhlcBar(key, b.open, b.high, b.low, b.close)
        else:
            buckets[key] = OhlcBar(
                key,
                cur.open,
                max(cur.high, b.high),
                min(cur.low, b.low),
                b.close,
            )
    return sorted(buckets.values(), key=lambda x: x.minute_key)


def closed_tf_bars(bars: list[OhlcBar], tf_minutes: int, now: datetime | None = None) -> list[OhlcBar]:
    """Keep only fully closed TF candles (bucket open + tf_minutes <= now)."""
    now = (now or datetime.now(IST)).astimezone(IST)
    out: list[OhlcBar] = []
    for b in bars:
        start = _minute_key_to_dt(b.minute_key)
        if start is None:
            continue
        end = start + timedelta(minutes=int(tf_minutes))
        if end <= now:
            out.append(b)
    return out


def compute_range(bars: list[OhlcBar]) -> dict[str, float] | None:
    if not bars:
        return None
    high = max(float(b.high) for b in bars)
    low = min(float(b.low) for b in bars)
    if not (high > 0 and low > 0 and high >= low):
        return None
    mid = (high + low) / 2.0
    gap = high - low
    return {"high": high, "low": low, "mid": mid, "gap": gap}


def fetch_spot_1m_bars(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
) -> list[OhlcBar]:
    """Fetch today's session 1-minute OHLC for spot."""
    now = datetime.now(IST)
    day_start = _session_start_ist(now)
    if now < day_start:
        return []

    merged: dict[int, OhlcBar] = {}
    cursor = day_start
    while cursor < now:
        chunk_end = min(cursor + timedelta(hours=1), now)
        try:
            raw = client.get_ohlc(
                exchange_segment=int(exchange_segment),
                exchange_instrument_id=int(exchange_instrument_id),
                start_time=_format_xts_time(cursor),
                end_time=_format_xts_time(chunk_end),
                compression_value=60,
            )
            if isinstance(raw, dict) and str(raw.get("type", "")).lower() == "error":
                _log.warning(
                    "angle ohlc error iid=%s: %s",
                    exchange_instrument_id,
                    raw.get("description") or raw.get("message"),
                )
            else:
                for bar in parse_ohlc_full(raw):
                    # Keep only session minutes
                    dt = _minute_key_to_dt(bar.minute_key)
                    if dt is None:
                        continue
                    if _session_start_ist(now) <= dt <= now:
                        merged[bar.minute_key] = bar
        except Exception as e:
            _log.warning("angle ohlc fail iid=%s: %s", exchange_instrument_id, e)
        cursor = chunk_end + timedelta(seconds=1)

    return sorted(merged.values(), key=lambda b: b.minute_key)


def build_angle_range_payload(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
    timeframe: str = "3m",
    window: int = 7,
    live_ltp: float = 0.0,
) -> dict[str, Any]:
    tf = str(timeframe or "3m").strip().lower()
    tf_min = TF_MINUTES.get(tf)
    if tf_min is None:
        return {"ok": False, "error": f"unsupported timeframe: {timeframe}"}

    win = max(1, min(int(window or 7), 50))
    bars_1m = fetch_spot_1m_bars(
        client,
        exchange_segment=exchange_segment,
        exchange_instrument_id=exchange_instrument_id,
    )
    rescaled = False
    if live_ltp and float(live_ltp) > 0 and bars_1m:
        before = bars_1m[-1].close if bars_1m else 0.0
        bars_1m = _rescale_bars_to_ltp(bars_1m, float(live_ltp))
        after = bars_1m[-1].close if bars_1m else 0.0
        rescaled = abs(after - before) > 0.5

    tf_bars = aggregate_1m_to_tf(bars_1m, tf_min)
    closed = closed_tf_bars(tf_bars, tf_min)
    last_n = closed[-win:] if len(closed) >= win else closed
    rng = compute_range(last_n)

    return {
        "ok": True,
        "timeframe": tf,
        "tfMinutes": tf_min,
        "compressionSec": 60,
        "window": win,
        "oneMinuteCount": len(bars_1m),
        "closedCount": len(closed),
        "barsUsed": len(last_n),
        "rescaled": rescaled,
        "liveLtp": float(live_ltp) if live_ltp else None,
        "ready": len(last_n) >= win and rng is not None,
        "range": rng,
        "bars": [
            {
                "t": b.minute_key,
                "label": (
                    f"{str(b.minute_key)[8:10]}:{str(b.minute_key)[10:12]}"
                    if len(str(b.minute_key)) == 12
                    else str(b.minute_key)
                ),
                "o": round(b.open, 2),
                "h": round(b.high, 2),
                "l": round(b.low, 2),
                "c": round(b.close, 2),
            }
            for b in last_n
        ],
    }
