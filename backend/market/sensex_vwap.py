"""
Cash-session VWAP of Sensex spot, the same line Nifty Wish uses for Nifty.

Each minute's price is ohlc4 = (open + high + low + close) / 4.
The weight is that minute's Sensex 30 BSE cash volume.
VWAP = sum(ohlc4 × constituent volume) / sum(constituent volume).
The Sensex last price is not this number.
"""

from __future__ import annotations

import logging
import threading
from datetime import date, datetime
from pathlib import Path
from typing import Any

from market.dada_range import IST
from market.nifty_vwap import (
    VwapCache,
    _bar_date,
    _master_lines,
    _xts_client,
    build_vwap_payload,
    constituent_ids,
    fetch_constituent_volume,
    fetch_xts_candles,
    fill_lagged_future_volume,
    front_future_symbol,
    parse_fyers_candles,
    set_vwap_md_client,
)

_log = logging.getLogger(__name__)

SPOT_SEGMENT = 11
SPOT_INSTRUMENT_ID = 26065
CASH_SERIES = ("A", "EQ", "B", "E")
# S&P BSE Sensex membership. BSE cash volume of these names is the chart weight.
SENSEX30_SYMBOLS = (
    "ADANIPORTS",
    "ASIANPAINT",
    "AXISBANK",
    "BAJAJFINSV",
    "BAJFINANCE",
    "BEL",
    "BHARTIARTL",
    "ETERNAL",
    "HCLTECH",
    "HDFCBANK",
    "HINDUNILVR",
    "ICICIBANK",
    "INDIGO",
    "INFY",
    "ITC",
    "KOTAKBANK",
    "LT",
    "M&M",
    "MARUTI",
    "NTPC",
    "POWERGRID",
    "RELIANCE",
    "SBIN",
    "SUNPHARMA",
    "TATASTEEL",
    "TCS",
    "TECHM",
    "TITAN",
    "TRENT",
    "ULTRACEMCO",
)

_VOLUME_LOCK = threading.Lock()
_VOLUME_CACHE: dict[str, Any] = {"day": None, "at": 0.0, "volumes": {}}


def ensure_cash_master() -> None:
    """Keep today's BSE cash master on disk so the 30 names can be mapped."""
    day = datetime.now(IST).strftime("%Y%m%d")
    cache_dir = Path(__file__).resolve().parent.parent / "cache"
    path = cache_dir / f"instruments_master_{day}_BSECM.txt"
    if path.is_file() and path.stat().st_size > 1000:
        return
    mapped = constituent_ids(
        _master_lines(),
        symbols=SENSEX30_SYMBOLS,
        cash_segment="BSECM",
        series=CASH_SERIES,
    )
    if len(mapped) >= 25:
        return
    try:
        client = _xts_client()
        resp = client.instruments_master(["BSECM"])
    except Exception as exc:
        _log.warning("sensex vwap BSECM master: %s", exc)
        return
    result = resp.get("result") if isinstance(resp, dict) else resp
    if isinstance(result, list):
        raw = "\n".join(str(row) for row in result)
    else:
        raw = str(result or "")
    if "BSECM|" not in raw and not raw.startswith("11|") and "\n11|" not in raw:
        _log.warning("sensex vwap: BSECM master had no cash lines")
        return
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(raw, encoding="utf-8")
    except OSError as exc:
        _log.warning("sensex vwap BSECM cache: %s", exc)


def lookup_future_symbol(on: date) -> str:
    """Display name of the front Sensex future. Its volume is not the VWAP weight."""
    try:
        return front_future_symbol(_master_lines(), "SENSEX", "BSEFO", on, series="IF")
    except Exception as exc:
        _log.info("sensex vwap future symbol: %s", exc)
        return ""


def compute_live_payload(now: datetime | None = None) -> dict[str, Any]:
    """Session ohlc4 VWAP. Price is Sensex spot. Weight is Sensex 30 BSE cash volume."""
    now = (now or datetime.now(IST)).astimezone(IST)
    ensure_cash_master()
    candles = fetch_xts_candles(now, segment=SPOT_SEGMENT, instrument_id=SPOT_INSTRUMENT_ID)
    symbol = lookup_future_symbol(now.date())
    parsed = parse_fyers_candles(candles)
    volumes: dict[int, float] = {}
    if parsed:
        session_day = _bar_date(parsed[0].minute_key) or now.date()
        printed = fetch_constituent_volume(
            session_day,
            now,
            symbols=SENSEX30_SYMBOLS,
            cash_segment="BSECM",
            series=CASH_SERIES,
            ohlc_segment=SPOT_SEGMENT,
            cache=_VOLUME_CACHE,
            lock=_VOLUME_LOCK,
            label="sensex",
            min_mapped=25,
            max_failed=6,
        )
        volumes = fill_lagged_future_volume(parsed, printed, now)
    return build_vwap_payload(
        candles,
        now,
        futures_by_minute=volumes,
        future_symbol=symbol,
        index_name="Sensex",
    )


_CACHE = VwapCache("sensex")


def get_vwap_payload() -> dict[str, Any]:
    return _CACHE.get(compute_live_payload)


def reset_vwap_cache() -> None:
    global _CACHE
    _CACHE = VwapCache("sensex")
