"""Last-trade LTP must follow 1501 touchline tick-to-tick (not stale 1502 / day high)."""
from __future__ import annotations

from market.ltp_pick import apply_feed_ltp, option_display_ltp, pick_index_ltp, pick_ltp_for_display, pick_option_ltp


def test_1501_tape_beats_later_1502() -> None:
    now = 1_700_000_000.0
    ltp = pick_ltp_for_display(99.0, 105.0, now - 0.05, now, now)
    assert abs(ltp - 99.0) < 1e-6


def test_1501_print_still_wins_when_newer() -> None:
    now = 1_700_000_000.0
    ltp = pick_ltp_for_display(100.40, 100.75, now, now - 0.05, now)
    assert abs(ltp - 100.40) < 1e-6


def test_1502_used_only_when_1501_missing() -> None:
    now = 1_700_000_000.0
    ltp = pick_ltp_for_display(0.0, 100.40, 0.0, now, now)
    assert abs(ltp - 100.40) < 1e-6


def test_1501_reprint_does_not_look_newer() -> None:
    t0 = 1_700_000_000.0
    ltp, ts = apply_feed_ltp(100.75, t0, 100.75, t0 + 0.2)
    assert abs(ltp - 100.75) < 1e-6
    assert abs(ts - t0) < 1e-9


def test_index_price_change_not_blocked_by_older_ts() -> None:
    t0 = 1_700_000_000.0
    ltp, ts = apply_feed_ltp(23225.45, t0, 23280.10, t0 - 50.0, ignore_older_ts=True)
    assert abs(ltp - 23280.10) < 1e-6
    assert abs(ts - (t0 - 50.0)) < 1e-9


def test_option_price_change_not_blocked_by_older_ts() -> None:
    t0 = 1_700_000_000.0
    ltp, ts = apply_feed_ltp(102.75, t0, 101.40, t0 - 50.0, ignore_older_ts=True)
    assert abs(ltp - 101.40) < 1e-6
    assert abs(ts - (t0 - 50.0)) < 1e-9


def test_index_frozen_1501_loses_to_moving_1502() -> None:
    t0 = 1_700_000_000.0
    ltp1, ts1 = apply_feed_ltp(0.0, 0.0, 23422.32, t0)
    ltp1, ts1 = apply_feed_ltp(ltp1, ts1, 23422.32, t0 + 5.0)
    ltp2, ts2 = apply_feed_ltp(0.0, 0.0, 23431.85, t0 + 1.0)
    ltp2, ts2 = apply_feed_ltp(ltp2, ts2, 23435.20, t0 + 5.2)
    picked = pick_index_ltp(ltp1, ltp2, ts1, ts2)
    assert abs(picked - 23435.20) < 1e-6
    assert abs(ts1 - t0) < 1e-9


def test_index_live_1501_beats_stale_1502() -> None:
    t0 = 1_700_000_000.0
    ltp2, ts2 = apply_feed_ltp(0.0, 0.0, 23443.35, t0)
    ltp2, ts2 = apply_feed_ltp(ltp2, ts2, 23443.35, t0 + 8.0)
    ltp1, ts1 = apply_feed_ltp(0.0, 0.0, 23433.10, t0 + 4.0)
    ltp1, ts1 = apply_feed_ltp(ltp1, ts1, 23434.55, t0 + 8.1)
    picked = pick_index_ltp(ltp1, ltp2, ts1, ts2)
    assert abs(picked - 23434.55) < 1e-6


def test_stale_1502_cannot_replace_live_1501() -> None:
    t0 = 1_700_000_000.0
    ltp1, ts1 = apply_feed_ltp(0.0, 0.0, 99.0, t0)
    ltp1, ts1 = apply_feed_ltp(ltp1, ts1, 99.0, t0 + 0.3)
    ltp2, ts2 = apply_feed_ltp(0.0, 0.0, 105.0, t0 + 0.4)
    picked = pick_ltp_for_display(ltp1, ltp2, ts1, ts2, t0 + 0.4)
    assert abs(picked - 99.0) < 1e-6
    option = pick_option_ltp(ltp1, ltp2, ts1, ts2, bid=98.95, ask=99.10)
    assert abs(option - 99.0) < 1e-6


def test_frozen_1501_follows_1502_inside_the_book() -> None:
    t0 = 1_700_000_000.0
    ltp1, ts1 = apply_feed_ltp(0.0, 0.0, 64.30, t0)
    ltp1, ts1 = apply_feed_ltp(ltp1, ts1, 64.30, t0 + 5.0)
    ltp2, ts2 = apply_feed_ltp(0.0, 0.0, 42.10, t0 + 1.0)
    ltp2, ts2 = apply_feed_ltp(ltp2, ts2, 41.85, t0 + 5.2)
    picked = pick_option_ltp(ltp1, ltp2, ts1, ts2, bid=41.70, ask=41.95)
    assert abs(picked - 41.85) < 1e-6


def test_rest_quote_replaces_frozen_option_tape() -> None:
    t0 = 1_700_000_000.0
    shown = option_display_ltp(64.30, 64.30, t0, t0, 64.20, 64.40, rest_ltp=41.90, rest_ts=t0 + 2.0)
    assert abs(shown - 41.90) < 1e-6
    live = option_display_ltp(41.50, 0.0, t0 + 3.0, 0.0, 41.40, 41.60, rest_ltp=41.90, rest_ts=t0 + 2.0)
    assert abs(live - 41.50) < 1e-6
