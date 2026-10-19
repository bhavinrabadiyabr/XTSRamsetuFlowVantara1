"""Cash-session Nifty spot VWAP. Price is ohlc4. Weight is the minute's volume."""

from __future__ import annotations

import time
from datetime import date, datetime

from market.dada_range import IST, OhlcBar
from market.nifty_vwap import (
    SpotBar,
    VwapCache,
    anchor_status,
    NIFTY50_SYMBOLS,
    build_vwap_payload,
    constituent_ids,
    fill_lagged_future_volume,
    front_future_id,
    parse_fyers_candles,
    round_px,
    select_session,
    session_vwap,
    stamp_futures_volume,
    typical_price,
    dhan_body_to_candles,
    xts_bars_to_candles,
)


def _epoch(year: int, month: int, day: int, hour: int, minute: int) -> int:
    return int(datetime(year, month, day, hour, minute, tzinfo=IST).timestamp())


def _candle(year, month, day, hour, minute, high, low, close, volume) -> list[float]:
    return [_epoch(year, month, day, hour, minute), close, high, low, close, volume]


def test_round_px_nudges_binary_half_up() -> None:
    assert round_px(100.005) == round(100.005 + 1e-9, 2)


def test_typical_price_uses_close_when_high_or_low_is_missing() -> None:
    assert typical_price(0, 90, 110) == 110
    assert typical_price(130, 0, 110) == 110
    assert typical_price(float("nan"), 90, 110) == 110
    assert abs(typical_price(130, 90, 110) - 110) < 1e-9


def test_session_vwap_is_ohlc4_weighted_by_volume() -> None:
    """09:15–09:19 dummy. Volume 1 on each minute: 125035 / 5 = 25007."""
    rows = [
        (25000.00, 25020.00, 24990.00, 25010.00),
        (25010.00, 25040.00, 25005.00, 25035.00),
        (25035.00, 25035.00, 25000.00, 25010.00),
        (25010.00, 25025.00, 24980.00, 24985.00),
        (24985.00, 25000.00, 24970.00, 24995.00),
    ]
    bars = [
        SpotBar(index, high, low, close, 1, index, open=opened)
        for index, (opened, high, low, close) in enumerate(rows, start=1)
    ]
    assert session_vwap(bars) == 25007.0
    heavy = [
        SpotBar(1, 25020.00, 24990.00, 25010.00, 1, 1, open=25000.00),
        SpotBar(2, 25040.00, 25005.00, 25035.00, 3, 2, open=25010.00),
    ]
    # (25005×1 + 25022.50×3) / 4 = 25018.125
    assert session_vwap(heavy) == 25018.13
    now = datetime(2026, 10, 9, 9, 20, tzinfo=IST)
    candles = [
        [_epoch(2026, 10, 9, 9, 15 + offset), opened, high, low, close, 1]
        for offset, (opened, high, low, close) in enumerate(rows)
    ]
    payload = build_vwap_payload(candles, now, futures_by_minute={})
    assert payload["ok"] is True
    assert payload["vwap"] == 25007.0
    assert payload["barsUsed"] == 5
    assert payload["lastMinute"] == "09:19"


def test_zero_volume_is_left_out_of_both_sums() -> None:
    bars = [
        SpotBar(1, 110, 110, 110, 0, 1, open=110),
        SpotBar(2, 200, 200, 200, 4, 2, open=200),
    ]
    assert session_vwap(bars) == 200.0


def test_passed_volume_map_weights_the_spot_ohlc4() -> None:
    """Index candles have volume 0. The passed minute volume is the weight."""
    now = datetime(2026, 10, 7, 10, 17, tzinfo=IST)
    candles = [
        _candle(2026, 10, 7, 10, 15, 110, 90, 100, 0),
        _candle(2026, 10, 7, 10, 16, 210, 190, 200, 0),
    ]
    weighted = build_vwap_payload(
        candles,
        now,
        futures_by_minute={202610071015: 1, 202610071016: 3},
    )
    plain = build_vwap_payload(candles, now, futures_by_minute={})
    # ohlc4 is 100 and 200. (100×1 + 200×3) / 4 = 175
    assert weighted["ok"] is True
    assert weighted["vwap"] == 175.0
    assert weighted["barsUsed"] == 2
    assert plain["ok"] is False


def test_unpublished_future_minutes_keep_the_recent_median_volume() -> None:
    """The futures print lags the spot bar. Those minutes stay in the session line."""
    now = datetime(2026, 10, 9, 9, 21, tzinfo=IST)
    candles = [
        _candle(2026, 10, 9, 9, 15, 100, 100, 100, 0),
        _candle(2026, 10, 9, 9, 16, 100, 100, 100, 0),
        _candle(2026, 10, 9, 9, 17, 100, 100, 100, 0),
        _candle(2026, 10, 9, 9, 18, 200, 200, 200, 0),
        _candle(2026, 10, 9, 9, 19, 200, 200, 200, 0),
        _candle(2026, 10, 9, 9, 20, 200, 200, 200, 0),
    ]
    printed = {202610090915: 10, 202610090916: 30, 202610090917: 20}
    filled = fill_lagged_future_volume(parse_fyers_candles(candles), printed, now)
    assert filled[202610090915] == 10
    assert filled[202610090918] == 20
    assert filled[202610090919] == 20
    assert filled[202610090920] == 20
    assert 202610090921 not in filled
    payload = build_vwap_payload(candles, now, futures_by_minute=filled)
    # 100×(10+30+20) + 200×(20+20+20) = 18000, over volume 120 → 150.
    assert payload["ok"] is True
    assert payload["vwap"] == 150.0
    assert payload["barsUsed"] == 6


def test_a_printed_future_minute_is_not_replaced_by_the_estimate() -> None:
    now = datetime(2026, 10, 9, 9, 20, tzinfo=IST)
    candles = [
        _candle(2026, 10, 9, 9, 15, 100, 100, 100, 0),
        _candle(2026, 10, 9, 9, 16, 100, 100, 100, 0),
        _candle(2026, 10, 9, 9, 17, 100, 100, 100, 0),
        _candle(2026, 10, 9, 9, 18, 200, 200, 200, 0),
    ]
    printed = {202610090915: 10, 202610090916: 30, 202610090917: 20, 202610090918: 5}
    filled = fill_lagged_future_volume(parse_fyers_candles(candles), printed, now)
    assert filled[202610090918] == 5
    assert filled.keys() == printed.keys()


def test_empty_future_map_is_not_invented() -> None:
    now = datetime(2026, 10, 9, 9, 20, tzinfo=IST)
    candles = [_candle(2026, 10, 9, 9, 15, 100, 100, 100, 0)]
    assert fill_lagged_future_volume(parse_fyers_candles(candles), {}, now) == {}


def test_empty_futures_series_keeps_spot_volume() -> None:
    bars = [SpotBar(202610070915, 110, 90, 100, 50, 1)]
    stamped = stamp_futures_volume(bars, {})
    assert stamped[0].futVolume == 50
    assert session_vwap(stamped) == 100.0


def test_last_closed_close_above_vwap_is_sell_pe() -> None:
    now = datetime(2026, 10, 7, 10, 16, tzinfo=IST)
    candles = [_candle(2026, 10, 7, 10, 15, 110, 90, 105, 10)]
    payload = build_vwap_payload(candles, now, futures_by_minute={})
    assert payload["vwap"] == round_px((105 + 110 + 90 + 105) / 4)
    assert payload["signal"] == "SELL_PE"
    below = build_vwap_payload([_candle(2026, 10, 7, 10, 15, 110, 90, 95, 10)], now, futures_by_minute={})
    assert below["signal"] == "SELL_CE"


def test_dhan_arrays_become_spot_candles() -> None:
    epoch = _epoch(2026, 10, 7, 9, 15)
    parsed = parse_fyers_candles(
        dhan_body_to_candles(
            {
                "open": [100],
                "high": [110],
                "low": [90],
                "close": [100],
                "volume": [250],
                "timestamp": [epoch],
            }
        )
    )
    assert len(parsed) == 1
    assert parsed[0].minute_key == 202610070915
    assert parsed[0].futVolume == 250
    assert parsed[0].close == 100
    skipped = dhan_body_to_candles(
        {
            "open": [1],
            "high": [1],
            "low": [1],
            "close": [1],
            "volume": [1],
            "timestamp": [epoch * 1000],
        }
    )
    assert parse_fyers_candles(skipped)[0].minute_key == 202610070915


def test_xts_minute_keeps_spot_volume() -> None:
    bar = OhlcBar(202610070915, 100, 110, 90, 100, 12)
    parsed = parse_fyers_candles(xts_bars_to_candles([bar]))
    assert len(parsed) == 1
    assert parsed[0].minute_key == 202610070915
    assert parsed[0].futVolume == 12
    assert parsed[0].high == 110
    assert parsed[0].low == 90
    assert parsed[0].close == 100


def test_millisecond_stamps_are_rejected() -> None:
    good = _candle(2026, 10, 7, 9, 16, 110, 90, 100, 10)
    bad = [good[0] * 1000, 100, 110, 90, 100, 99]
    parsed = parse_fyers_candles([bad, good, [good[0], 100, 110, 90, 0, 5]])
    assert len(parsed) == 1
    assert parsed[0].futVolume == 10
    assert parsed[0].close == 100


def test_bars_outside_the_cash_window_are_dropped() -> None:
    early = _candle(2026, 10, 7, 9, 14, 100, 100, 100, 10)
    late = _candle(2026, 10, 7, 15, 30, 100, 100, 100, 10)
    keep = _candle(2026, 10, 7, 15, 29, 100, 100, 100, 10)
    parsed = parse_fyers_candles([early, late, keep])
    assert len(parsed) == 1
    assert parsed[0].minute_key == 202610071529


def test_live_session_does_not_fall_back_to_yesterday() -> None:
    now = datetime(2026, 10, 7, 10, 0, tzinfo=IST)
    candles = [_candle(2026, 10, 6, 10, 0, 100, 100, 100, 10)]
    payload = build_vwap_payload(candles, now, futures_by_minute={})
    assert payload["ok"] is False
    assert payload["error"] == "Today has no Nifty candles"
    assert payload["vwap"] == 0


def test_after_the_close_uses_the_latest_prior_date() -> None:
    now = datetime(2026, 10, 7, 15, 31, tzinfo=IST)
    candles = [_candle(2026, 10, 6, 10, 0, 110, 90, 100, 10)]
    payload = build_vwap_payload(candles, now, futures_by_minute={})
    assert payload["ok"] is True
    assert payload["sessionDate"] == "2026-10-06"
    assert payload["vwap"] == 100.0


def test_weekend_uses_the_latest_date_before_today() -> None:
    now = datetime(2026, 10, 10, 11, 0, tzinfo=IST)  # Saturday
    candles = [
        _candle(2026, 10, 9, 10, 0, 110, 90, 100, 10),
        _candle(2026, 10, 10, 10, 0, 200, 200, 200, 10),
    ]
    session, error = select_session(parse_fyers_candles(candles), now)
    assert error is None
    assert session == date(2026, 10, 9)


def test_before_the_open_uses_the_prior_date() -> None:
    now = datetime(2026, 10, 7, 9, 14, tzinfo=IST)
    candles = [_candle(2026, 10, 6, 15, 20, 110, 90, 100, 8)]
    payload = build_vwap_payload(candles, now, futures_by_minute={})
    assert payload["sessionDate"] == "2026-10-06"
    assert payload["vwap"] == 100.0


def test_forming_minute_changes_live_vwap_only() -> None:
    now = datetime(2026, 10, 7, 10, 16, 30, tzinfo=IST)
    candles = [
        _candle(2026, 10, 7, 10, 15, 110, 90, 100, 100),
        _candle(2026, 10, 7, 10, 16, 220, 180, 200, 100),
    ]
    payload = build_vwap_payload(candles, now, futures_by_minute={999: 1})
    assert payload["vwap"] == 100.0
    assert payload["liveVwap"] == 150.0
    assert payload["barsUsed"] == 1
    assert payload["lastMinute"] == "10:15"
    assert payload["lastClose"] == 100.0
    assert payload["formingMinute"] == "10:16"
    assert payload["signal"] == "NONE"
    assert payload["signalLabel"] == "No trade"


def test_passed_futures_volume_is_not_what_live_compute_uses() -> None:
    now = datetime(2026, 10, 7, 10, 16, tzinfo=IST)
    candles = [_candle(2026, 10, 7, 10, 15, 110, 90, 100, 50)]
    live = build_vwap_payload(candles, now, futures_by_minute={})
    assert live["vwap"] == 100.0
    overridden = build_vwap_payload(candles, now, futures_by_minute={202610071015: 0})
    assert overridden["ok"] is False


def test_anchor_matches_only_when_hlc_and_vwap_agree() -> None:
    now = datetime(2026, 10, 7, 10, 0, tzinfo=IST)
    # Open is chosen so this single bar's ohlc4 is the anchor VWAP, and H/L/C match.
    matched_bar = [_epoch(2026, 10, 7, 9, 52), 22405.98, 22612.95, 22607.15, 22609.00, 1]
    matched = build_vwap_payload([matched_bar], now, futures_by_minute={})
    assert matched["at0952"]["match"] is True
    assert matched["at0952"]["vwap"] == 22558.77
    anchor_bar = [_epoch(2026, 10, 7, 9, 52), 22609.00, 22612.95, 22607.15, 22609.00, 1]
    seed = _candle(2026, 10, 7, 9, 15, 22558.77, 22558.77, 22558.77, 1_000_000)
    pinned = build_vwap_payload([seed, anchor_bar], now, futures_by_minute={})
    assert pinned["at0952"]["match"] is True
    assert abs(pinned["at0952"]["vwap"] - 22558.77) <= 0.15
    alone = build_vwap_payload([anchor_bar], now, futures_by_minute={})
    assert alone["at0952"]["match"] is False
    assert alone["at0952"]["high"] == 22612.95
    closed = parse_fyers_candles([anchor_bar])
    assert anchor_status(closed)["match"] is False


def test_constituent_ids_are_the_cash_equities() -> None:
    assert len(NIFTY50_SYMBOLS) == 50
    lines = [
        "NSEFO|1|1|RELIANCE|RELIANCE26OCTFUT|FUTSTK|x|1|1|1|1|1|1|1|1|x|2026-10-27|x",
        "NSECM|2885|8|RELIANCE|RELIANCE-EQ|EQ|x|1|1|1|1|1|1|1|RELIANCE|x|1|1|x|0|-1|-1",
        "NSECM|9|8|NESTLEIND|NESTLEIND-EQ|EQ|x|1|1|1|1|1|1|1|NESTLEIND|x|1|1|x|0|-1|-1",
        "NSECM|7|8|WIPRO|WIPRO-EQ|EQ|x|1|1|1|1|1|1|1|WIPRO|x|1|1|x|0|-1|-1",
    ]
    found = constituent_ids(lines)
    assert found["RELIANCE"] == 2885
    assert found["NESTLEIND"] == 9
    assert "WIPRO" not in found


def test_sensex_cash_ids_and_front_future() -> None:
    from market.sensex_vwap import SENSEX30_SYMBOLS

    assert len(SENSEX30_SYMBOLS) == 30
    lines = [
        "BSECM|500325|8|RELIANCE|RELIANCE|A|x|1|1|1|1|1|1|1|RELIANCE|x|1|1|x|0|-1|-1",
        "BSECM|500180|8|HDFCBANK|HDFCBANK|A|x|1|1|1|1|1|1|1|HDFCBANK|x|1|1|x|0|-1|-1",
        "BSECM|9|8|WIPRO|WIPRO|A|x|1|1|1|1|1|1|1|WIPRO|x|1|1|x|0|-1|-1",
        "NSECM|2885|8|RELIANCE|RELIANCE-EQ|EQ|x|1|1|1|1|1|1|1|RELIANCE|x|1|1|x|0|-1|-1",
        "BSEFO|1117804|4|SENSEX|SENSEX26OCT26NOVFUT|IF|SENSEX-IF|1|1|1|1|1|1|1|1||2026-10-29T00:00:00|spd",
        "BSEFO|864571|1|SENSEX|SENSEX26OCTFUT|IF|SENSEX-IF|1|1|1|1|1|1|1|1|SENSEX|2026-10-29T00:00:00|SENSEX 29OCT2026",
        "BSEFO|1100929|1|SENSEX|SENSEX26NOVFUT|IF|SENSEX-IF|1|1|1|1|1|1|1|1|SENSEX|2026-11-26T00:00:00|SENSEX 26NOV2026",
    ]
    found = constituent_ids(lines, symbols=SENSEX30_SYMBOLS, cash_segment="BSECM", series=("A", "EQ", "B"))
    assert found["RELIANCE"] == 500325
    assert found["HDFCBANK"] == 500180
    assert "WIPRO" not in found
    assert front_future_id(lines, "SENSEX", "BSEFO", date(2026, 10, 19), series="IF") == 864571
    now = datetime(2026, 10, 19, 10, 0, tzinfo=IST)
    candles = [_candle(2026, 10, 16, 10, 0, 100, 100, 100, 10)]
    payload = build_vwap_payload(candles, now, futures_by_minute={}, index_name="Sensex")
    assert payload["error"] == "Today has no Sensex candles"


def test_front_future_is_the_nearest_unexpired_contract() -> None:
    lines = [
        "NSEFO|12527099|1|NIFTY|NIFTY26OCT26DECFUT|FUTIDX|NIFTY-FUTIDX|1|1|1|1|1|1|1|1|Nifty 50|2026-10-27T14:30:00|NIFTY 27OCT2026",
        "NSEFO|58875|1|NIFTY|NIFTY26DECFUT|FUTIDX|NIFTY-FUTIDX|1|1|1|1|1|1|1|1|Nifty 50|2026-12-29T14:30:00|NIFTY 29DEC2026",
        "NSEFO|48704|1|NIFTY|NIFTY26OCTFUT|FUTIDX|NIFTY-FUTIDX|1|1|1|1|1|1|1|1|Nifty 50|2026-10-27T14:30:00|NIFTY 27OCT2026",
        "NSEFO|61471|1|NIFTY|NIFTY26NOVFUT|FUTIDX|NIFTY-FUTIDX|1|1|1|1|1|1|1|1|Nifty 50|2026-11-24T14:30:00|NIFTY 24NOV2026",
        "NSEFO|9|1|NIFTYNXT50|NIFTYNXT5026OCTFUT|FUTIDX|x|1|1|1|1|1|1|1|1|x|2026-10-27T14:30:00|x",
        "NSEFO|8|1|NIFTY|NIFTY26SEPFUT|FUTIDX|x|1|1|1|1|1|1|1|1|x|2026-09-29T14:30:00|x",
    ]
    assert front_future_id(lines, "NIFTY", "NSEFO", date(2026, 10, 5)) == 48704


def test_failed_refresh_keeps_the_last_good_session() -> None:
    cache = VwapCache()
    calls = {"n": 0}

    def compute() -> dict:
        calls["n"] += 1
        if calls["n"] == 1:
            return {"ok": True, "vwap": 100.0, "stale": False, "error": None}
        raise RuntimeError("fyers down")

    first = cache.get(compute)
    assert first["vwap"] == 100.0
    assert first["stale"] is False
    cache.at -= CACHE_GAP
    second = cache.get(compute)
    assert second["vwap"] == 100.0
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if cache.payload and cache.payload.get("stale"):
            break
        time.sleep(0.02)
    assert cache.payload is not None
    assert cache.payload["vwap"] == 100.0
    assert cache.payload["stale"] is True
    assert "fyers down" in str(cache.payload["error"])


CACHE_GAP = 13
