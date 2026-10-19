"""
1-minute 9/21 EMA cross, 200 EMA side mark, opening range, previous-day high/low.

Same rules as the TradingView study:
- BULL when a closed candle finishes above both EMA 9 and EMA 21, and the previous close did not
- BEAR when it finishes below both, and the previous close did not
- For the signal candle and the next 9 closed candles, a star if close is above or below EMA 200
- Opening range is 09:15–09:30 IST
- EMA uses the TradingView seed: SMA of the first length, then alpha = 2 / (length + 1)
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import date, datetime, timedelta
from datetime import time as dtime
from typing import Any
from zoneinfo import ZoneInfo

from market.dada_range import (
    OhlcBar,
    _minute_key_to_dt,
    _rescale_bars_to_ltp,
    aggregate_1m_to_tf,
    fetch_range_1m_bars,
)

_log = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
EMA9 = 9
EMA21 = 21
EMA200 = 200
STAR_BARS = 10
DISPLAY_BARS = 450
CHART_MINUTES = (1, 2, 3, 5, 10, 15, 30)
_FRESH_S = 20.0
_HISTORY_S = 300.0

_guard = threading.Lock()
_key_locks: dict[tuple[int, int], threading.Lock] = {}
_bar_cache: dict[tuple[int, int], tuple[float, list[OhlcBar]]] = {}


def ema_series(values: list[float], length: int) -> list[float | None]:
    n = len(values)
    out: list[float | None] = [None] * n
    if length <= 0 or n < length:
        return out
    alpha = 2.0 / (length + 1.0)
    prev = sum(values[:length]) / float(length)
    out[length - 1] = prev
    for i in range(length, n):
        prev = alpha * values[i] + (1.0 - alpha) * prev
        out[i] = prev
    return out


def mark_signals(
    closes: list[float],
    e9: list[float | None],
    e21: list[float | None],
    e200: list[float | None],
    confirmed: list[bool] | None = None,
    star_bars: int = STAR_BARS,
) -> tuple[list[str | None], list[str | None]]:
    n = len(closes)
    if confirmed is None:
        confirmed = [True] * n
    signals: list[str | None] = [None] * n
    stars: list[str | None] = [None] * n
    since = 9999
    for i in range(n):
        if not confirmed[i]:
            continue
        a9, a21 = e9[i], e21[i]
        above = a9 is not None and a21 is not None and closes[i] > a9 and closes[i] > a21
        below = a9 is not None and a21 is not None and closes[i] < a9 and closes[i] < a21
        prev_above = False
        prev_below = False
        if i > 0 and e9[i - 1] is not None and e21[i - 1] is not None and confirmed[i - 1]:
            prev_above = closes[i - 1] > e9[i - 1] and closes[i - 1] > e21[i - 1]
            prev_below = closes[i - 1] < e9[i - 1] and closes[i - 1] < e21[i - 1]
        bull = above and not prev_above
        bear = below and not prev_below
        if bull or bear:
            since = 0
            signals[i] = "BULL" if bull else "BEAR"
        else:
            since += 1
        if since < star_bars and e200[i] is not None:
            if closes[i] > e200[i]:
                stars[i] = "up"
            elif closes[i] < e200[i]:
                stars[i] = "down"
    return signals, stars


def opening_range(bars: list[OhlcBar], day: date) -> tuple[float | None, float | None]:
    hi: float | None = None
    lo: float | None = None
    for bar in bars:
        dt = _minute_key_to_dt(bar.minute_key)
        if dt is None or dt.date() != day:
            continue
        if dt.hour == 9 and 15 <= dt.minute < 30:
            hi = bar.high if hi is None else max(hi, bar.high)
            lo = bar.low if lo is None else min(lo, bar.low)
    return hi, lo


def previous_day_levels(bars: list[OhlcBar], day: date) -> tuple[float | None, float | None]:
    prev: date | None = None
    for bar in bars:
        dt = _minute_key_to_dt(bar.minute_key)
        if dt is None or dt.date() >= day:
            continue
        if prev is None or dt.date() > prev:
            prev = dt.date()
    if prev is None:
        return None, None
    hi: float | None = None
    lo: float | None = None
    for bar in bars:
        dt = _minute_key_to_dt(bar.minute_key)
        if dt is None or dt.date() != prev:
            continue
        hi = bar.high if hi is None else max(hi, bar.high)
        lo = bar.low if lo is None else min(lo, bar.low)
    return hi, lo


def _r(value: float | None) -> float | None:
    if value is None:
        return None
    return round(float(value), 2)


def chart_minutes(value: object) -> int:
    try:
        minutes = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 1
    return minutes if minutes in CHART_MINUTES else 1


def _bar_closed(minute_key: int, now: datetime, tf_minutes: int = 1) -> bool:
    start = _minute_key_to_dt(minute_key)
    if start is None:
        return False
    return start + timedelta(minutes=max(1, int(tf_minutes))) <= now.astimezone(IST)


def _in_session(now: datetime) -> bool:
    now = now.astimezone(IST)
    if now.weekday() >= 5:
        return False
    t = now.timetz().replace(tzinfo=None)
    return dtime(9, 15) <= t < dtime(15, 30)


def expected_closed_minute_key(now: datetime) -> int | None:
    """Minute key of the candle that should already be closed, or None outside the session."""
    now = now.astimezone(IST)
    if not _in_session(now):
        return None
    closed_start = now.replace(second=0, microsecond=0) - timedelta(minutes=1)
    session_open = now.replace(hour=9, minute=15, second=0, microsecond=0)
    if closed_start < session_open:
        return None
    return int(closed_start.strftime("%Y%m%d%H%M"))


def cache_has_closed_bar(bars: list[OhlcBar], now: datetime) -> bool:
    """False when a just-closed minute is missing, so the next check refetches immediately."""
    need = expected_closed_minute_key(now)
    if need is None:
        return True
    return any(bar.minute_key == need for bar in bars)


def _label(minute_key: int, prev_key: int | None) -> str:
    s = str(int(minute_key))
    if len(s) != 12:
        return s
    hhmm = f"{s[8:10]}:{s[10:12]}"
    if prev_key is not None and str(int(prev_key))[:8] != s[:8]:
        return f"{s[6:8]} {hhmm}"
    return hhmm


def _with_live_print(bars: list[OhlcBar], now: datetime, live_ltp: float) -> list[OhlcBar]:
    if not bars or not (live_ltp > 0) or not _in_session(now):
        return bars
    now = now.astimezone(IST).replace(second=0, microsecond=0)
    now_key = int(now.strftime("%Y%m%d%H%M"))
    last = bars[-1]
    px = float(live_ltp)
    if last.minute_key == now_key:
        return bars[:-1] + [
            OhlcBar(last.minute_key, last.open, max(last.high, px), min(last.low, px), px)
        ]
    if last.minute_key < now_key:
        seed = last.close
        return bars + [OhlcBar(now_key, seed, max(seed, px), min(seed, px), px)]
    return bars


def build_chart_from_bars(
    bars: list[OhlcBar],
    *,
    now: datetime | None = None,
    live_ltp: float = 0.0,
    display_bars: int = DISPLAY_BARS,
    tf_minutes: int = 1,
) -> dict[str, Any]:
    now = (now or datetime.now(IST)).astimezone(IST)
    tf = chart_minutes(tf_minutes)
    series = sorted(bars, key=lambda b: b.minute_key)
    if live_ltp and float(live_ltp) > 0 and series:
        series = _rescale_bars_to_ltp(series, float(live_ltp))
    series = _with_live_print(series, now, float(live_ltp or 0))

    if not series:
        return {
            "ok": True,
            "tf": f"{tf}m",
            "minutes": tf,
            "orbHigh": None,
            "orbLow": None,
            "pdh": None,
            "pdl": None,
            "bars": [],
        }

    latest = _minute_key_to_dt(series[-1].minute_key)
    session_day = latest.date() if latest is not None else now.date()
    orb_hi, orb_lo = opening_range(series, session_day)
    pdh, pdl = previous_day_levels(series, session_day)
    if tf > 1:
        series = aggregate_1m_to_tf(series, tf)

    closes = [b.close for b in series]
    e9 = ema_series(closes, EMA9)
    e21 = ema_series(closes, EMA21)
    e200 = ema_series(closes, EMA200)
    confirmed = [_bar_closed(b.minute_key, now, tf) for b in series]
    signals, stars = mark_signals(closes, e9, e21, e200, confirmed)

    start = max(0, len(series) - int(display_bars))
    out: list[dict[str, Any]] = []
    prev_key: int | None = series[start - 1].minute_key if start > 0 else None
    for i in range(start, len(series)):
        bar = series[i]
        out.append(
            {
                "t": bar.minute_key,
                "label": _label(bar.minute_key, prev_key),
                "o": _r(bar.open),
                "h": _r(bar.high),
                "l": _r(bar.low),
                "c": _r(bar.close),
                "e9": _r(e9[i]),
                "e21": _r(e21[i]),
                "e200": _r(e200[i]),
                "signal": signals[i],
                "star": stars[i],
            }
        )
        prev_key = bar.minute_key

    return {
        "ok": True,
        "tf": f"{tf}m",
        "minutes": tf,
        "orbHigh": _r(orb_hi),
        "orbLow": _r(orb_lo),
        "pdh": _r(pdh),
        "pdl": _r(pdl),
        "bars": out,
    }


def _recent_weekdays(now: datetime, count: int = 2) -> list[date]:
    out: list[date] = []
    d = now.astimezone(IST).date()
    guard = 0
    while len(out) < count and guard < 14:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
        guard += 1
    return out


def _session_window(day: date, now: datetime) -> tuple[datetime, datetime] | None:
    now = now.astimezone(IST)
    start = datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST)
    end = datetime(day.year, day.month, day.day, 15, 30, tzinfo=IST)
    if now < start:
        return None
    return start, min(now, end)


def _lock_for(key: tuple[int, int]) -> threading.Lock:
    with _guard:
        lk = _key_locks.get(key)
        if lk is None:
            lk = threading.Lock()
            _key_locks[key] = lk
        return lk


def _fetch_sessions(client: Any, seg: int, iid: int, now: datetime) -> list[OhlcBar]:
    merged: dict[int, OhlcBar] = {}
    for day in reversed(_recent_weekdays(now, 2)):
        window = _session_window(day, now)
        if window is None:
            continue
        start, end = window
        for bar in fetch_range_1m_bars(
            client,
            exchange_segment=seg,
            exchange_instrument_id=iid,
            start=start,
            end=end,
        ):
            merged[bar.minute_key] = bar
    return sorted(merged.values(), key=lambda b: b.minute_key)


def load_recent_bars(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
    fresh: bool = False,
) -> list[OhlcBar]:
    key = (int(exchange_segment), int(exchange_instrument_id))
    now = datetime.now(IST)
    now_ts = time.time()
    with _lock_for(key):
        hit = _bar_cache.get(key)
        if not fresh and hit and now_ts - hit[0] < _FRESH_S and cache_has_closed_bar(hit[1], now):
            return list(hit[1])

        bars: list[OhlcBar] = []
        if not fresh and hit and now_ts - hit[0] < _HISTORY_S and hit[1]:
            last_dt = _minute_key_to_dt(hit[1][-1].minute_key)
            if last_dt is not None:
                start = last_dt - timedelta(minutes=2)
                end = min(now, datetime(now.year, now.month, now.day, 15, 30, tzinfo=IST))
                if end >= start:
                    try:
                        fresh = fetch_range_1m_bars(
                            client,
                            exchange_segment=key[0],
                            exchange_instrument_id=key[1],
                            start=start,
                            end=end,
                        )
                    except Exception as exc:
                        _log.warning("ema cross refresh failed iid=%s: %s", key[1], exc)
                        fresh = []
                    merged = {b.minute_key: b for b in hit[1]}
                    for bar in fresh:
                        merged[bar.minute_key] = bar
                    bars = sorted(merged.values(), key=lambda b: b.minute_key)
        if not bars:
            bars = _fetch_sessions(client, key[0], key[1], now)
        if bars:
            _bar_cache[key] = (now_ts, bars)
            return list(bars)
        if hit:
            return list(hit[1])
        return []


def build_ema_cross_payload(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
    live_ltp: float = 0.0,
    tf_minutes: int = 1,
) -> dict[str, Any]:
    bars = load_recent_bars(
        client,
        exchange_segment=exchange_segment,
        exchange_instrument_id=exchange_instrument_id,
    )
    return build_chart_from_bars(bars, live_ltp=float(live_ltp or 0), tf_minutes=chart_minutes(tf_minutes))
