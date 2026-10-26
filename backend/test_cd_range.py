"""CD range uses the last N closed TF bars. The forming bar stays out."""

from datetime import datetime

from market.cd_range import build_cd_range, first_entry_label, parse_range_params
from market.dada_range import IST, OhlcBar


def bar(hh: int, mm: int, high: float, low: float) -> OhlcBar:
    return OhlcBar(int(f"20261026{hh:02d}{mm:02d}"), high, high, low, low)


def test_forming_bar_and_gap():
    bars = [
        bar(9, 15, 100, 90),
        bar(9, 30, 110, 80),
        bar(9, 45, 120, 70),
        bar(10, 0, 130, 60),
        bar(10, 15, 400, 10),
    ]
    early = build_cd_range(bars, datetime(2026, 10, 26, 10, 14, tzinfo=IST))
    assert early["ready"] is False
    assert early["closedCount"] == 3

    live = build_cd_range(bars, datetime(2026, 10, 26, 10, 20, tzinfo=IST))
    assert live["ready"] is True
    assert live["high"] == 130
    assert live["low"] == 60
    assert live["mid"] == 95
    assert live["gap"] == 70
    assert live["tradable"] is True
    assert live["firstBar"] == "09:15"
    assert live["lastBar"] == "10:00"
    assert live["high"] != 400


def test_last_four_and_tight_gap():
    bars = [
        bar(9, 15, 200, 10),
        bar(9, 30, 101, 90),
        bar(9, 45, 102, 91),
        bar(10, 0, 103, 92),
        bar(10, 15, 104, 93),
    ]
    payload = build_cd_range(bars, datetime(2026, 10, 26, 10, 30, tzinfo=IST))
    assert payload["firstBar"] == "09:30"
    assert payload["lastBar"] == "10:15"
    assert payload["high"] == 104
    assert payload["low"] == 90
    assert payload["gap"] == 14
    assert payload["tradable"] is False


def test_saved_tf_candles_and_gap():
    bars = [
        bar(9, 15, 100, 90),
        bar(9, 20, 140, 80),
        bar(9, 25, 400, 10),
    ]
    early = build_cd_range(bars, datetime(2026, 10, 26, 9, 24, tzinfo=IST), candles=2, tf_minutes=5, min_gap=50)
    assert early["ready"] is False
    assert early["firstEntry"] == "09:25"
    live = build_cd_range(bars, datetime(2026, 10, 26, 9, 25, tzinfo=IST), candles=2, tf_minutes=5, min_gap=50)
    assert live["ready"] is True
    assert live["high"] == 140
    assert live["low"] == 80
    assert live["gap"] == 60
    assert live["tradable"] is True
    assert live["firstBar"] == "09:15"
    assert live["lastBar"] == "09:20"
    tight = build_cd_range(bars, datetime(2026, 10, 26, 9, 25, tzinfo=IST), candles=2, tf_minutes=5, min_gap=70)
    assert tight["tradable"] is False
    assert first_entry_label(4, 15) == "10:15"
    assert parse_range_params("15", "4", "50") == {"tf_minutes": 15, "candles": 4, "min_gap": 50.0}
    assert parse_range_params("61", "4", "50") is None
    assert parse_range_params("15", "0", "50") is None
    assert parse_range_params("15", "4", "5001") is None


def test_yesterday_does_not_fill_the_window():
    old = OhlcBar(202610230915, 500, 500, 100, 100)
    payload = build_cd_range([old, bar(9, 15, 110, 40)], datetime(2026, 10, 26, 11, 0, tzinfo=IST))
    assert payload["ready"] is False
    assert payload["closedCount"] == 1


if __name__ == "__main__":
    test_forming_bar_and_gap()
    test_last_four_and_tight_gap()
    test_saved_tf_candles_and_gap()
    test_yesterday_does_not_fill_the_window()
    print("cd_range ok")
