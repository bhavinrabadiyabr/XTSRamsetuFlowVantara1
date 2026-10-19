"""9/21 cross, 200 EMA star, ORB, and previous-day levels."""

from __future__ import annotations

from datetime import date, datetime, timedelta

from market.dada_range import OhlcBar
from market.ema_cross import (
    IST,
    build_chart_from_bars,
    cache_has_closed_bar,
    chart_minutes,
    ema_series,
    expected_closed_minute_key,
    mark_signals,
    opening_range,
    previous_day_levels,
)


def test_ema_seeds_with_sma_then_smooths() -> None:
    series = ema_series([1, 2, 3, 4, 5], 3)
    assert series[0] is None and series[1] is None
    assert series[2] is not None and abs(series[2] - 2.0) < 1e-9
    assert series[3] is not None and abs(series[3] - 3.0) < 1e-9
    assert series[4] is not None and abs(series[4] - 4.0) < 1e-9


def test_star_lasts_ten_closed_bars_after_bull() -> None:
    n = 15
    closes = [100.0] * n
    e9 = [90.0] * n
    e21 = [90.0] * n
    e200 = [95.0] * n
    signals, stars = mark_signals(closes, e9, e21, e200)
    assert signals[0] == "BULL"
    assert signals[1] is None
    assert stars[:10] == ["up"] * 10
    assert stars[10] is None


def test_bear_when_close_drops_under_both() -> None:
    closes = [100.0] * 5 + [80.0] * 3
    e9 = [90.0] * 8
    e21 = [90.0] * 8
    e200 = [90.0] * 8
    signals, stars = mark_signals(closes, e9, e21, e200)
    assert signals[0] == "BULL"
    assert signals[5] == "BEAR"
    assert stars[5] == "down"


def test_forming_bar_does_not_signal() -> None:
    closes = [100.0, 130.0]
    e9 = [90.0, 90.0]
    e21 = [90.0, 90.0]
    e200 = [95.0, 95.0]
    signals, stars = mark_signals(closes, e9, e21, e200, confirmed=[True, False])
    assert signals == ["BULL", None]
    assert stars[1] is None


def test_orb_and_previous_day() -> None:
    bars = [
        OhlcBar(202609250915, 100, 110, 90, 105),
        OhlcBar(202609251000, 105, 130, 100, 120),
        OhlcBar(202609280914, 120, 121, 119, 120),
        OhlcBar(202609280915, 120, 125, 118, 124),
        OhlcBar(202609280929, 124, 128, 117, 127),
        OhlcBar(202609280930, 127, 140, 126, 139),
    ]
    hi, lo = opening_range(bars, date(2026, 9, 28))
    assert hi == 128 and lo == 117
    pdh, pdl = previous_day_levels(bars, date(2026, 9, 28))
    assert pdh == 130 and pdl == 90


def test_missing_closed_bar_is_not_treated_as_fresh() -> None:
    now = datetime(2026, 9, 28, 11, 28, 2, tzinfo=IST)
    assert expected_closed_minute_key(now) == 202609281127
    closed = [OhlcBar(202609281127, 100, 101, 99, 100)]
    stale = [OhlcBar(202609281126, 100, 101, 99, 100)]
    assert cache_has_closed_bar(closed, now) is True
    assert cache_has_closed_bar(stale, now) is False
    before_open = datetime(2026, 9, 28, 9, 15, 30, tzinfo=IST)
    assert expected_closed_minute_key(before_open) is None
    assert cache_has_closed_bar(stale, before_open) is True


def test_chart_minutes_keeps_supported_steps() -> None:
    assert chart_minutes(5) == 5
    assert chart_minutes("15") == 15
    assert chart_minutes(4) == 1
    assert chart_minutes("nope") == 1


def test_five_minute_candle_stays_open_until_bucket_ends() -> None:
    start = datetime(2026, 9, 28, 11, 15, tzinfo=IST)
    bars = []
    for i in range(8):
        dt = start + timedelta(minutes=i)
        px = 200.0 + i
        bars.append(OhlcBar(int(dt.strftime("%Y%m%d%H%M")), px, px + 2, px - 2, px + 1))

    payload = build_chart_from_bars(bars, now=datetime(2026, 9, 28, 11, 23, tzinfo=IST), tf_minutes=5)
    assert payload["minutes"] == 5
    assert [row["t"] for row in payload["bars"]] == [202609281115, 202609281120]
    assert payload["bars"][0]["o"] == 200.0
    assert payload["bars"][0]["c"] == 205.0
    assert payload["bars"][1]["signal"] is None


def test_payload_bull_on_closed_cross_only() -> None:
    start = datetime(2026, 9, 28, 9, 15, tzinfo=IST)
    bars = []
    for i in range(30):
        dt = start + timedelta(minutes=i)
        key = int(dt.strftime("%Y%m%d%H%M"))
        px = 100.0 if i < 29 else 130.0
        bars.append(OhlcBar(key, px, px + 1, px - 1, px))

    closed_at = start + timedelta(minutes=40)
    payload = build_chart_from_bars(bars, now=closed_at)
    assert any(row["signal"] == "BULL" for row in payload["bars"])

    forming_at = start + timedelta(minutes=29, seconds=20)
    live = build_chart_from_bars(bars, now=forming_at)
    assert all(row["signal"] != "BULL" or row["t"] != bars[-1].minute_key for row in live["bars"])
    last = live["bars"][-1]
    assert last["signal"] is None
