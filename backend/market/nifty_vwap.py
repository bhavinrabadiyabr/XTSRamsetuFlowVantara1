"""
Cash-session VWAP of Nifty spot, matching the chart line VWAP (ohlc4, Session).

Each minute's price is ohlc4 = (open + high + low + close) / 4.
The weight is that minute's Nifty 50 cash volume: the sum of the 50
constituent stocks. The index candle itself prints volume 0, and the
front future's volume is not this weight.
VWAP = sum(ohlc4 × constituent volume) / sum(constituent volume).
The Nifty last price is not this number. Touchline AverageTradedPrice is not used.
"""

from __future__ import annotations

import logging
import math
import os
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

import requests

from market.dada_range import IST

_log = logging.getLogger(__name__)

SPOT_SYMBOL = "NSE:NIFTY50-INDEX"
SPOT_SEGMENT = 1
SPOT_INSTRUMENT_ID = 26000
FUT_SEGMENT = 2
DHAN_INTRADAY_URL = "https://api.dhan.co/v2/charts/intraday"
DHAN_NIFTY_SECURITY_ID = "13"
DHAN_EXCHANGE_SEGMENT = "IDX_I"
DHAN_INSTRUMENT = "INDEX"
CACHE_SECONDS = 12.0
HISTORY_DAYS = 6
MS_STAMP = 10_000_000_000
ANCHOR_HIGH = 22612.95
ANCHOR_LOW = 22607.15
ANCHOR_CLOSE = 22609.00
ANCHOR_VWAP = 22558.77
ANCHOR_PX_TOL = 0.02
ANCHOR_VWAP_TOL = 0.15
VOLUME_REFRESH_SECONDS = 20.0
# NSE Indices Nifty 50 membership. Cash volume of these names is the chart weight.
NIFTY50_SYMBOLS = (
    "ADANIENT",
    "ADANIPORTS",
    "APOLLOHOSP",
    "ASIANPAINT",
    "AXISBANK",
    "BAJAJ-AUTO",
    "BAJAJFINSV",
    "BAJFINANCE",
    "BEL",
    "BHARTIARTL",
    "BSE",
    "CIPLA",
    "COALINDIA",
    "DRREDDY",
    "EICHERMOT",
    "ETERNAL",
    "GRASIM",
    "HCLTECH",
    "HDFCBANK",
    "HDFCLIFE",
    "HINDALCO",
    "HINDUNILVR",
    "ICICIBANK",
    "INDIGO",
    "INFY",
    "ITC",
    "JIOFIN",
    "JSWSTEEL",
    "KOTAKBANK",
    "LT",
    "M&M",
    "MARUTI",
    "MAXHEALTH",
    "NESTLEIND",
    "NTPC",
    "ONGC",
    "POWERGRID",
    "RELIANCE",
    "SBILIFE",
    "SBIN",
    "SHRIRAMFIN",
    "SUNPHARMA",
    "TATACONSUM",
    "TATASTEEL",
    "TCS",
    "TECHM",
    "TITAN",
    "TMPV",
    "TRENT",
    "ULTRACEMCO",
)

ANCHOR = {
    "minute": "09:52",
    "high": ANCHOR_HIGH,
    "low": ANCHOR_LOW,
    "close": ANCHOR_CLOSE,
    "vwap": ANCHOR_VWAP,
    "pxTol": ANCHOR_PX_TOL,
    "vwapTol": ANCHOR_VWAP_TOL,
}


@dataclass(frozen=True)
class SpotBar:
    minute_key: int
    high: float
    low: float
    close: float
    futVolume: float
    epoch: int
    open: float = 0.0


def round_px(value: float) -> float:
    """Two decimals. 1e-9 is added first so a binary .xx5 does not fall the wrong way."""
    return round(float(value) + 1e-9, 2)


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def typical_price(high: float, low: float, close: float) -> float | None:
    """(high + low + close) / 3. Missing or non-positive high or low uses the close."""
    px = _finite(close)
    if px is None or not (px > 0):
        return None
    hi = _finite(high)
    lo = _finite(low)
    if hi is None or lo is None or not (hi > 0) or not (lo > 0):
        return px
    return (hi + lo + px) / 3.0


def bar_price(bar: SpotBar) -> float | None:
    """Chart source is ohlc4: (open + high + low + close) / 4. That is the session VWAP line."""
    opened = _finite(bar.open)
    if opened is not None and opened > 0 and bar.high > 0 and bar.low > 0 and bar.close > 0:
        return (opened + bar.high + bar.low + bar.close) / 4.0
    return typical_price(bar.high, bar.low, bar.close)


def session_vwap(bars: list[SpotBar]) -> float:
    """sum(ohlc4 × volume) / sum(volume). Zero volume is left out.

    The result is rounded with round(value + 1e-9, 2). Zero means the sum has
    nothing to stand on. The Nifty last price is never used as this line.
    """
    total_pv = 0.0
    total_volume = 0.0
    for bar in bars:
        volume = float(bar.futVolume)
        if not (volume > 0):
            continue
        price = bar_price(bar)
        if price is None:
            continue
        total_pv += price * volume
        total_volume += volume
    if not (total_volume > 0):
        return 0.0
    return round_px(total_pv / total_volume)


def stamp_futures_volume(bars: list[SpotBar], volume_by_minute: dict[int, float]) -> list[SpotBar]:
    """Replace futVolume only when a futures series is passed.

    The live compute passes an empty series, so the spot candle volume stays.
    """
    if not volume_by_minute:
        return list(bars)
    stamped: list[SpotBar] = []
    for bar in bars:
        key = int(bar.minute_key)
        if key not in volume_by_minute:
            stamped.append(bar)
            continue
        stamped.append(replace(bar, futVolume=float(volume_by_minute[key] or 0.0)))
    return stamped


def _expiry_day(text: str) -> date | None:
    head = str(text or "").split("T", 1)[0].strip()
    if len(head) < 10:
        return None
    try:
        return date.fromisoformat(head[:10])
    except ValueError:
        return None


def _monthly_future_symbol(root: str, symbol: str) -> bool:
    """True for NIFTY26OCTFUT. Calendar spreads such as NIFTY26OCT26DECFUT are not the chart contract."""
    name = symbol.strip().upper()
    root_u = root.strip().upper()
    if not name.startswith(root_u) or not name.endswith("FUT"):
        return False
    body = name[len(root_u) : -3]
    return len(body) == 5 and body[:2].isdigit() and body[2:].isalpha()


def front_future_id(
    lines: list[str],
    root: str,
    segment: str,
    on: date,
    series: str = "FUTIDX",
) -> int | None:
    """Nearest unexpired monthly future instrument id. Not used as VWAP weight."""
    found = _front_future(lines, root, segment, on, series=series)
    return found[0] if found else None


def front_future_symbol(
    lines: list[str],
    root: str,
    segment: str,
    on: date,
    series: str = "FUTIDX",
) -> str:
    found = _front_future(lines, root, segment, on, series=series)
    return found[1] if found else ""


def _front_future(
    lines: list[str],
    root: str,
    segment: str,
    on: date,
    series: str = "FUTIDX",
) -> tuple[int, str] | None:
    root_u = root.strip().upper()
    segment_u = segment.strip().upper()
    series_u = series.strip().upper() or "FUTIDX"
    best: tuple[date, int, str] | None = None
    for line in lines:
        if root_u not in line:
            continue
        if series_u == "FUTIDX" and "FUTIDX" not in line:
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) < 17:
            continue
        if parts[0].upper() != segment_u or parts[3].upper() != root_u or parts[5].upper() != series_u:
            continue
        if not _monthly_future_symbol(root_u, parts[4]):
            continue
        expiry = _expiry_day(parts[16])
        if expiry is None or expiry < on:
            continue
        try:
            instrument_id = int(parts[1])
        except ValueError:
            continue
        if instrument_id <= 0:
            continue
        if best is None or expiry < best[0]:
            best = (expiry, instrument_id, parts[4])
    if best is None:
        return None
    return best[1], best[2]


def _master_lines() -> list[str]:
    """Today's instrument masters joined together.

    Nifty cash and Sensex futures land in different cache files. Reading only
    the first file drops the other book.
    """
    cache_dir = Path(__file__).resolve().parent.parent / "cache"
    day = datetime.now(IST).strftime("%Y%m%d")
    paths = sorted(cache_dir.glob(f"instruments_master_{day}_*.txt"))
    if not paths:
        paths = sorted(cache_dir.glob("instruments_master_*.txt"))
        for path in paths:
            try:
                return path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
        return []
    lines: list[str] = []
    for path in paths:
        try:
            lines.extend(path.read_text(encoding="utf-8", errors="replace").splitlines())
        except OSError:
            continue
    return lines


def constituent_ids(
    lines: list[str],
    symbols: tuple[str, ...] | None = None,
    cash_segment: str = "NSECM",
    series: tuple[str, ...] = ("EQ",),
) -> dict[str, int]:
    """Cash equity instrument ids for the given names. Nifty 50 on NSECM is the default."""
    wanted = {symbol.upper() for symbol in (NIFTY50_SYMBOLS if symbols is None else symbols)}
    segment_u = cash_segment.strip().upper()
    segments = {segment_u}
    if segment_u == "BSECM":
        segments.add("11")
    elif segment_u == "NSECM":
        segments.add("1")
    allowed = {item.strip().upper() for item in series if item.strip()}
    rank = {"A": 0, "EQ": 1, "B": 2, "E": 3}
    found: dict[str, int] = {}
    found_rank: dict[str, int] = {}
    for line in lines:
        parts = [part.strip() for part in line.split("|")]
        if len(parts) < 6:
            continue
        if parts[0].upper() not in segments or parts[5].upper() not in allowed:
            continue
        symbol = parts[3].upper()
        if symbol not in wanted:
            continue
        try:
            instrument_id = int(parts[1])
        except ValueError:
            continue
        if instrument_id <= 0:
            continue
        this_rank = rank.get(parts[5].upper(), 9)
        if symbol in found and found_rank.get(symbol, 9) <= this_rank:
            continue
        found[symbol] = instrument_id
        found_rank[symbol] = this_rank
    return found


def lookup_future_symbol(on: date) -> str:
    """Display name of the front Nifty future. Its volume is not the VWAP weight."""
    try:
        return front_future_symbol(_master_lines(), "NIFTY", "NSEFO", on)
    except Exception as exc:
        _log.info("nifty vwap future symbol: %s", exc)
        return ""


def _minute_key(dt: datetime) -> int:
    return int(dt.astimezone(IST).strftime("%Y%m%d%H%M"))


def _bar_date(minute_key: int) -> date | None:
    text = str(int(minute_key))
    if len(text) != 12:
        return None
    try:
        return date(int(text[0:4]), int(text[4:6]), int(text[6:8]))
    except ValueError:
        return None


def _hhmm(minute_key: int) -> int:
    return int(minute_key) % 10000


def _in_window(minute_key: int) -> bool:
    hhmm = _hhmm(minute_key)
    return 915 <= hhmm <= 1529


def parse_fyers_candles(candles: list[Any]) -> list[SpotBar]:
    """Rows are [epoch seconds, open, high, low, close, spot volume].

    XTS minutes are converted into this shape. A millisecond stamp is rejected.
    Bars outside 09:15–15:29 IST, and bars with no positive close, are dropped.
    Volume is stored as futVolume.
    """
    out: list[SpotBar] = []
    for row in candles or []:
        if not isinstance(row, (list, tuple)) or len(row) < 5:
            continue
        stamp = _finite(row[0])
        if stamp is None or stamp <= 0 or stamp > MS_STAMP:
            continue
        epoch = int(stamp)
        try:
            opened = datetime.fromtimestamp(epoch, IST)
        except (OverflowError, OSError, ValueError):
            continue
        minute = opened.replace(second=0, microsecond=0)
        key = _minute_key(minute)
        if not _in_window(key):
            continue
        close = _finite(row[4])
        if close is None or not (close > 0):
            continue
        opened = _finite(row[1]) if len(row) > 1 else None
        high = _finite(row[2]) if len(row) > 2 else None
        low = _finite(row[3]) if len(row) > 3 else None
        volume = _finite(row[5]) if len(row) > 5 else 0.0
        if volume is None or volume < 0:
            volume = 0.0
        out.append(
            SpotBar(
                minute_key=key,
                high=high if high is not None else 0.0,
                low=low if low is not None else 0.0,
                close=close,
                futVolume=volume,
                epoch=epoch,
                open=opened if opened is not None and opened > 0 else close,
            )
        )
    out.sort(key=lambda bar: (bar.minute_key, bar.epoch))
    collapsed: dict[int, SpotBar] = {}
    for bar in out:
        collapsed[bar.minute_key] = bar
    return [collapsed[key] for key in sorted(collapsed)]


def select_session(
    bars: list[SpotBar],
    now: datetime,
    *,
    index_name: str = "Nifty",
) -> tuple[date | None, str | None]:
    """Which cash date the signal VWAP belongs to.

    Weekday 09:15 through 15:30 uses today only. A weekday after 15:30 uses
    today when it has candles, otherwise the latest prior date. A weekend, or
    a weekday before 09:15, uses the latest date strictly before today.
    """
    now = now.astimezone(IST)
    today = now.date()
    clock = (now.hour, now.minute)
    dates = {day for bar in bars if (day := _bar_date(bar.minute_key)) is not None}
    prior = sorted(day for day in dates if day < today)
    latest_prior = prior[-1] if prior else None
    weekday = now.weekday() < 5
    if weekday and (9, 15) <= clock <= (15, 30):
        if today in dates:
            return today, None
        return None, f"Today has no {index_name} candles"
    if weekday and clock > (15, 30):
        if today in dates:
            return today, None
        if latest_prior is not None:
            return latest_prior, None
        return None, "No session candles"
    if latest_prior is not None:
        return latest_prior, None
    return None, "No prior session candles"


def split_closed_forming(bars: list[SpotBar], now: datetime) -> tuple[list[SpotBar], SpotBar | None]:
    """A minute is still forming while now < minute + 1 minute."""
    now = now.astimezone(IST)
    closed: list[SpotBar] = []
    forming: SpotBar | None = None
    for bar in bars:
        text = str(int(bar.minute_key))
        try:
            start = datetime(
                int(text[0:4]),
                int(text[4:6]),
                int(text[6:8]),
                int(text[8:10]),
                int(text[10:12]),
                tzinfo=IST,
            )
        except (ValueError, IndexError):
            continue
        if now < start + timedelta(minutes=1):
            if forming is None or bar.minute_key > forming.minute_key:
                forming = bar
            continue
        closed.append(bar)
    return closed, forming


def _clock_label(minute_key: int | None) -> str | None:
    if minute_key is None:
        return None
    text = str(int(minute_key))
    if len(text) < 12:
        return None
    return f"{text[8:10]}:{text[10:12]}"


def _near(value: float, target: float, tol: float) -> bool:
    return math.isfinite(value) and abs(value - target) <= tol + 1e-9


def anchor_status(closed: list[SpotBar]) -> dict[str, Any] | None:
    """09:52 H/L/C and the VWAP through that bar. Display only. It does not block orders."""
    bar = next((row for row in closed if _hhmm(row.minute_key) == 952), None)
    if bar is None:
        return None
    through = [row for row in closed if row.minute_key <= bar.minute_key]
    vwap = session_vwap(through)
    hlc = (
        _near(bar.high, ANCHOR_HIGH, ANCHOR_PX_TOL)
        and _near(bar.low, ANCHOR_LOW, ANCHOR_PX_TOL)
        and _near(bar.close, ANCHOR_CLOSE, ANCHOR_PX_TOL)
    )
    return {
        "minute": "09:52",
        "high": round_px(bar.high) if bar.high > 0 else bar.high,
        "low": round_px(bar.low) if bar.low > 0 else bar.low,
        "close": round_px(bar.close),
        "vwap": vwap,
        "match": bool(hlc and vwap > 0 and _near(vwap, ANCHOR_VWAP, ANCHOR_VWAP_TOL)),
    }


def signal_for_close(close: float, vwap: float) -> tuple[str, str]:
    """Last closed candle versus session VWAP. The panel does not trade off this."""
    if not (close > 0 and vwap > 0):
        return "NONE", "No trade"
    spot = round_px(close)
    line = round_px(vwap)
    if spot > line:
        return "SELL_PE", "Sell PE"
    if spot < line:
        return "SELL_CE", "Sell CE"
    return "NONE", "No trade"


def _blank(error: str | None, *, stale: bool = False, future_symbol: str = "") -> dict[str, Any]:
    return {
        "ok": False,
        "error": error,
        "stale": stale,
        "vwap": 0.0,
        "liveVwap": 0.0,
        "lastClose": 0.0,
        "lastMinute": None,
        "barsUsed": 0,
        "formingMinute": None,
        "sessionDate": None,
        "futureSymbol": future_symbol,
        "at0952": None,
        "anchor": dict(ANCHOR),
        "signal": "NONE",
        "signalLabel": "No trade",
    }


def build_vwap_payload(
    candles: list[Any],
    now: datetime,
    *,
    futures_by_minute: dict[int, float] | None = None,
    future_symbol: str = "",
    index_name: str = "Nifty",
) -> dict[str, Any]:
    """Signal VWAP from closed spot minutes. liveVwap may include the forming minute."""
    now = now.astimezone(IST)
    parsed = parse_fyers_candles(candles)
    bars = stamp_futures_volume(parsed, futures_by_minute or {})
    session, error = select_session(bars, now, index_name=index_name)
    if session is None:
        return _blank(error, future_symbol=future_symbol)
    day_bars = [bar for bar in bars if _bar_date(bar.minute_key) == session]
    closed, forming = split_closed_forming(day_bars, now)
    vwap = session_vwap(closed)
    live_bars = list(closed)
    if forming is not None and forming.futVolume > 0 and bar_price(forming) is not None:
        live_bars.append(forming)
    live = session_vwap(live_bars)
    used = [bar for bar in closed if bar.futVolume > 0 and bar_price(bar) is not None]
    last = closed[-1] if closed else None
    if not (vwap > 0) or last is None:
        payload = _blank(
            f"No trade. Missing {index_name} volume" if last is not None else "No closed minute",
            future_symbol=future_symbol,
        )
        payload["sessionDate"] = session.isoformat()
        payload["lastClose"] = float(last.close) if last is not None else 0.0
        payload["lastMinute"] = _clock_label(last.minute_key) if last is not None else None
        payload["formingMinute"] = _clock_label(forming.minute_key) if forming is not None else None
        payload["at0952"] = anchor_status(closed)
        return payload
    signal, label = signal_for_close(last.close, vwap)
    return {
        "ok": True,
        "error": None,
        "stale": False,
        "vwap": vwap,
        "liveVwap": live if live > 0 else vwap,
        "lastClose": round_px(last.close),
        "lastMinute": _clock_label(last.minute_key),
        "barsUsed": len(used),
        "formingMinute": _clock_label(forming.minute_key) if forming is not None else None,
        "sessionDate": session.isoformat(),
        "futureSymbol": future_symbol,
        "at0952": anchor_status(closed),
        "anchor": dict(ANCHOR),
        "signal": signal,
        "signalLabel": label,
    }


_MD_CLIENT: Callable[[], Any] | None = None


def set_vwap_md_client(getter: Callable[[], Any] | None) -> None:
    """XTS market-data client used by the live refresh. Set from the API route."""
    global _MD_CLIENT
    _MD_CLIENT = getter


def xts_bars_to_candles(bars: list[Any]) -> list[list[float]]:
    """XTS minute bars as epoch-second rows. Millisecond stamps are not produced."""
    candles: list[list[float]] = []
    for bar in bars or []:
        minute_key = int(getattr(bar, "minute_key", 0) or 0)
        text = str(minute_key)
        if len(text) != 12:
            continue
        try:
            opened = datetime(
                int(text[0:4]),
                int(text[4:6]),
                int(text[6:8]),
                int(text[8:10]),
                int(text[10:12]),
                tzinfo=IST,
            )
        except ValueError:
            continue
        epoch = int(opened.timestamp())
        if epoch <= 0 or epoch > MS_STAMP:
            continue
        candles.append(
            [
                float(epoch),
                float(getattr(bar, "open", 0.0) or 0.0),
                float(getattr(bar, "high", 0.0) or 0.0),
                float(getattr(bar, "low", 0.0) or 0.0),
                float(getattr(bar, "close", 0.0) or 0.0),
                float(getattr(bar, "volume", 0.0) or 0.0),
            ]
        )
    return candles


def _recent_session_days(now: datetime) -> list[date]:
    """Today once the cash session has opened. Otherwise the previous weekdays."""
    now = now.astimezone(IST)
    day = now.date()
    if now.weekday() >= 5 or (now.hour, now.minute) < (9, 15):
        day -= timedelta(days=1)
    days: list[date] = []
    while len(days) < HISTORY_DAYS:
        if day.weekday() < 5:
            days.append(day)
        day -= timedelta(days=1)
    return days


def _fetch_day_bars(client: Any, segment: int, instrument_id: int, day: date, now: datetime) -> list[Any]:
    from market.dada_range import fetch_range_1m_bars

    start = datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST)
    end = datetime(day.year, day.month, day.day, 15, 29, tzinfo=IST)
    if day == now.astimezone(IST).date() and end > now:
        end = now.astimezone(IST).replace(second=0, microsecond=0)
    if end < start:
        return []
    return fetch_range_1m_bars(
        client,
        exchange_segment=segment,
        exchange_instrument_id=instrument_id,
        start=start,
        end=end,
    )


def _xts_client() -> Any:
    if _MD_CLIENT is None:
        raise RuntimeError("XTS history is not configured")
    client = _MD_CLIENT()
    if client is None:
        raise RuntimeError("XTS history is not configured")
    return client


def fetch_xts_candles(
    now: datetime | None = None,
    *,
    segment: int = SPOT_SEGMENT,
    instrument_id: int = SPOT_INSTRUMENT_ID,
) -> list[Any]:
    """1-minute spot bars from XTS. Index volume on this feed is 0."""
    now = (now or datetime.now(IST)).astimezone(IST)
    client = _xts_client()
    for day in _recent_session_days(now):
        candles = xts_bars_to_candles(
            _fetch_day_bars(client, segment, instrument_id, day, now)
        )
        if candles:
            return candles
    raise RuntimeError("XTS history has no candles")


def fill_lagged_future_volume(
    bars: list[SpotBar],
    volume_by_minute: dict[int, float],
    now: datetime,
) -> dict[int, float]:
    """Give spot minutes a weight while the futures print for that minute is still out.

    The chart's session line already includes those minutes. Dropping them
    leaves the VWAP several points behind on a fast open. The estimate is the
    median of the last five printed futures minutes. It is only applied after
    the last printed minute, through the current minute, and only on a spot
    bar that has no futures volume yet.
    """
    published = {int(key): float(volume) for key, volume in volume_by_minute.items() if float(volume or 0) > 0}
    if not published or not bars:
        return dict(volume_by_minute)
    last_key = max(published)
    last_day = _bar_date(last_key)
    recent = [published[key] for key in sorted(published)[-5:]]
    weight = float(statistics.median(recent))
    if not (weight > 0) or last_day is None:
        return dict(published)
    current_key = _minute_key(now.astimezone(IST).replace(second=0, microsecond=0))
    filled = dict(published)
    for bar in bars:
        key = int(bar.minute_key)
        if key <= last_key or key > current_key or key in filled:
            continue
        if _bar_date(key) != last_day:
            continue
        filled[key] = weight
    return filled


def fetch_xts_future_volume(day: date, now: datetime | None = None) -> dict[int, float]:
    """Front Nifty future 1-minute volume, keyed by the cash minute.

    Used only as the weight when the index candles themselves have no volume.
    The future's price is not the VWAP.
    """
    now = (now or datetime.now(IST)).astimezone(IST)
    try:
        client = _xts_client()
    except RuntimeError:
        return {}
    instrument_id = front_future_id(_master_lines(), "NIFTY", "NSEFO", day)
    if not instrument_id:
        _log.warning("nifty vwap: no front future for %s", day.isoformat())
        return {}
    try:
        bars = _fetch_day_bars(client, FUT_SEGMENT, int(instrument_id), day, now)
    except Exception as exc:
        _log.warning("nifty vwap future volume: %s", exc)
        return {}
    volumes: dict[int, float] = {}
    for bar in bars:
        volume = float(getattr(bar, "volume", 0.0) or 0.0)
        if volume > 0:
            volumes[int(getattr(bar, "minute_key", 0) or 0)] = volume
    return volumes


def _dhan_env() -> tuple[str, str]:
    client = (os.getenv("DHAN_CLIENT_ID") or "").strip()
    token = (os.getenv("DHAN_ACCESS_TOKEN") or "").strip()
    if client and token:
        return client, token
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.is_file():
        try:
            for line in env_path.read_text(encoding="utf-8").splitlines():
                row = line.strip()
                if not row or row.startswith("#") or "=" not in row:
                    continue
                key, _, val = row.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ and val:
                    os.environ[key] = val
        except OSError:
            pass
    return (os.getenv("DHAN_CLIENT_ID") or "").strip(), (os.getenv("DHAN_ACCESS_TOKEN") or "").strip()


def dhan_body_to_candles(body: Any) -> list[list[float]]:
    """Dhan intraday arrays to [epoch seconds, open, high, low, close, volume]."""
    if not isinstance(body, dict):
        return []
    opens = body.get("open") or []
    highs = body.get("high") or []
    lows = body.get("low") or []
    closes = body.get("close") or []
    volumes = body.get("volume") or []
    stamps = body.get("timestamp") or body.get("start_Time") or []
    count = min(len(opens), len(highs), len(lows), len(closes), len(volumes), len(stamps))
    candles: list[list[float]] = []
    for index in range(count):
        stamp = _finite(stamps[index])
        if stamp is None or stamp <= 0:
            continue
        if stamp > MS_STAMP:
            stamp = stamp / 1000.0
        if stamp > MS_STAMP:
            continue
        volume = _finite(volumes[index])
        candles.append(
            [
                float(stamp),
                float(_finite(opens[index]) or 0.0),
                float(_finite(highs[index]) or 0.0),
                float(_finite(lows[index]) or 0.0),
                float(_finite(closes[index]) or 0.0),
                float(volume or 0.0),
            ]
        )
    return candles


def _dhan_day_candles(client_id: str, token: str, start: datetime, end: datetime) -> list[list[float]]:
    response = requests.post(
        DHAN_INTRADAY_URL,
        headers={
            "access-token": token,
            "client-id": client_id,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        json={
            "securityId": DHAN_NIFTY_SECURITY_ID,
            "exchangeSegment": DHAN_EXCHANGE_SEGMENT,
            "instrument": DHAN_INSTRUMENT,
            "interval": "1",
            "oi": False,
            "fromDate": start.astimezone(IST).strftime("%Y-%m-%d %H:%M:%S"),
            "toDate": end.astimezone(IST).strftime("%Y-%m-%d %H:%M:%S"),
        },
        timeout=12,
    )
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"Dhan history failed ({response.status_code})") from exc
    if isinstance(body, dict) and (body.get("errorMessage") or body.get("errorCode") or body.get("error_message")):
        message = str(body.get("errorMessage") or body.get("error_message") or body.get("errorCode"))
        raise RuntimeError(message)
    if not response.ok:
        raise RuntimeError(f"Dhan history failed ({response.status_code})")
    return dhan_body_to_candles(body)


def fetch_dhan_candles(now: datetime | None = None) -> list[Any]:
    """About six sessions of Dhan 1-minute Nifty 50 candles. Volume is index constituent volume."""
    now = (now or datetime.now(IST)).astimezone(IST)
    client_id, token = _dhan_env()
    if not client_id or not token:
        raise RuntimeError("Dhan VWAP is not configured. Set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN")
    candles: list[Any] = []
    errors: list[str] = []
    for offset in range(HISTORY_DAYS):
        day = now.date() - timedelta(days=offset)
        if day.weekday() >= 5:
            continue
        start = datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST)
        end = datetime(day.year, day.month, day.day, 15, 30, tzinfo=IST)
        if now < start:
            continue
        if end > now + timedelta(minutes=1):
            end = (now + timedelta(minutes=1)).replace(second=0, microsecond=0)
        if end <= start:
            continue
        try:
            candles.extend(_dhan_day_candles(client_id, token, start, end))
        except Exception as exc:
            errors.append(str(exc))
            _log.warning("dhan vwap %s: %s", day.isoformat(), exc)
        time.sleep(0.15)
    if not candles:
        detail = errors[0] if errors else "no candles"
        raise RuntimeError(f"Dhan history has no candles: {detail}")
    return candles


def _add_volumes(into: dict[int, float], book: dict[int, float]) -> None:
    for key, volume in book.items():
        weight = float(volume or 0.0)
        if weight > 0:
            minute = int(key)
            into[minute] = into.get(minute, 0.0) + weight


def _fetch_symbol_volume(
    client: Any,
    instrument_id: int,
    start: datetime,
    end: datetime,
    *,
    segment: int = SPOT_SEGMENT,
) -> dict[int, float]:
    from market.dada_range import _format_xts_time, parse_ohlc_full

    raw = client.get_ohlc(
        exchange_segment=segment,
        exchange_instrument_id=int(instrument_id),
        start_time=_format_xts_time(start),
        end_time=_format_xts_time(end),
        compression_value=60,
    )
    return {
        int(bar.minute_key): float(bar.volume)
        for bar in parse_ohlc_full(raw)
        if float(getattr(bar, "volume", 0.0) or 0.0) > 0
    }


_VOLUME_LOCK = threading.Lock()
_VOLUME_CACHE: dict[str, Any] = {"day": None, "at": 0.0, "volumes": {}}


def fetch_constituent_volume(
    day: date,
    now: datetime | None = None,
    *,
    symbols: tuple[str, ...] | None = None,
    cash_segment: str = "NSECM",
    series: tuple[str, ...] = ("EQ",),
    ohlc_segment: int = SPOT_SEGMENT,
    cache: dict[str, Any] | None = None,
    lock: threading.Lock | None = None,
    label: str = "nifty",
    min_mapped: int = 45,
    max_failed: int = 10,
) -> dict[int, float]:
    """Sum of constituent cash 1-minute volume, keyed by the cash minute.

    This is the weight on the chart's session VWAP. The result is reused for
    20 seconds so the desk does not pull every name on every refresh.
    """
    now = (now or datetime.now(IST)).astimezone(IST)
    store = _VOLUME_CACHE if cache is None else cache
    gate = _VOLUME_LOCK if lock is None else lock
    names = NIFTY50_SYMBOLS if symbols is None else symbols
    with gate:
        cached_day = store["day"]
        cached = dict(store["volumes"] or {})
        fresh = (
            cached_day == day
            and bool(cached)
            and time.monotonic() - float(store["at"]) < VOLUME_REFRESH_SECONDS
        )
    if fresh:
        return cached
    try:
        client = _xts_client()
    except RuntimeError:
        return cached
    ids = constituent_ids(_master_lines(), symbols=names, cash_segment=cash_segment, series=series)
    if len(ids) < min_mapped:
        _log.warning("%s vwap constituents mapped %s/%s", label, len(ids), len(names))
    if not ids:
        return cached
    start = datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST)
    end = now if now.date() == day else datetime(day.year, day.month, day.day, 15, 29, tzinfo=IST)
    if end < start:
        return cached
    def load(symbol: str, instrument_id: int) -> tuple[str, dict[int, float]]:
        return symbol, _fetch_symbol_volume(client, instrument_id, start, end, segment=ohlc_segment)

    totals: dict[int, float] = {}
    pending = dict(ids)
    failed = 0
    for _attempt in (1, 2):
        if not pending:
            break
        missed: dict[str, int] = {}
        with ThreadPoolExecutor(max_workers=8) as pool:
            jobs = [pool.submit(load, symbol, instrument_id) for symbol, instrument_id in pending.items()]
            for job in as_completed(jobs):
                try:
                    symbol, volume_book = job.result()
                except Exception:
                    continue
                _add_volumes(totals, volume_book)
                pending.pop(symbol, None)
        for symbol, instrument_id in list(pending.items()):
            missed[symbol] = instrument_id
        pending = missed
    failed = len(pending)
    if failed:
        _log.warning(
            "%s vwap constituent volume failed %s/%s %s",
            label,
            failed,
            len(ids),
            ",".join(sorted(pending)),
        )
    if not totals or (failed > max_failed and cached and len(cached) >= len(totals)):
        return cached
    with gate:
        store["day"] = day
        store["at"] = time.monotonic()
        store["volumes"] = dict(totals)
    _log.info(
        "%s vwap weight=constituents minutes=%s symbols=%s failed=%s",
        label,
        len(totals),
        len(ids) - failed,
        failed,
    )
    return dict(totals)


def compute_live_payload(now: datetime | None = None) -> dict[str, Any]:
    """Session ohlc4 VWAP. Price is Nifty spot. Weight is Nifty 50 cash volume."""
    now = (now or datetime.now(IST)).astimezone(IST)
    candles = fetch_xts_candles(now)
    symbol = lookup_future_symbol(now.date())
    parsed = parse_fyers_candles(candles)
    volumes: dict[int, float] = {}
    if parsed:
        session_day = _bar_date(parsed[0].minute_key) or now.date()
        printed = fetch_constituent_volume(session_day, now)
        volumes = fill_lagged_future_volume(parsed, printed, now)
    return build_vwap_payload(
        candles,
        now,
        futures_by_minute=volumes,
        future_symbol=symbol,
    )


class VwapCache:
    """12 second cache. After the first good payload, refresh is a daemon thread."""

    def __init__(self, name: str = "nifty") -> None:
        self.name = name
        self.payload: dict[str, Any] | None = None
        self.at = 0.0
        self.refreshing = False
        self._lock = threading.Lock()

    def get(self, compute: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            good = self.payload if self.payload and self.payload.get("ok") else None
            if good is not None and now - self.at < CACHE_SECONDS:
                return dict(good)
            if good is not None:
                if not self.refreshing:
                    self.refreshing = True
                    threading.Thread(
                        target=self._refresh,
                        args=(compute,),
                        name=f"{self.name}-vwap-refresh",
                        daemon=True,
                    ).start()
                return dict(good)
        payload = self._run(compute)
        if payload.get("ok"):
            self._store(payload)
        return payload

    def _run(self, compute: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        try:
            payload = compute()
        except Exception as exc:
            _log.warning("%s vwap compute failed: %s", self.name, exc)
            return _blank(str(exc))
        if not isinstance(payload, dict):
            return _blank(f"{self.name} VWAP payload missing")
        return payload

    def _store(self, payload: dict[str, Any]) -> None:
        stored = dict(payload)
        stored["stale"] = False
        with self._lock:
            self.payload = stored
            self.at = time.monotonic()

    def _mark_stale(self, error: str) -> None:
        with self._lock:
            if not self.payload or not self.payload.get("ok"):
                return
            kept = dict(self.payload)
            kept["stale"] = True
            kept["error"] = error
            self.payload = kept

    def _refresh(self, compute: Callable[[], dict[str, Any]]) -> None:
        try:
            payload = self._run(compute)
            if payload.get("ok"):
                self._store(payload)
            else:
                message = str(payload.get("error") or "refresh failed")
                _log.warning("%s vwap refresh kept last session: %s", self.name, message)
                self._mark_stale(message)
        finally:
            with self._lock:
                self.refreshing = False


_CACHE = VwapCache()


def get_vwap_payload() -> dict[str, Any]:
    return _CACHE.get(compute_live_payload)


def reset_vwap_cache() -> None:
    global _CACHE
    _CACHE = VwapCache()
