"""1 min Fast locks the 09:20 one-minute open. Later bars and OHLC4 cannot move it."""

from __future__ import annotations

from datetime import datetime

from market.dada_range import IST, OhlcBar
from market.fast1_open import get_open, open_from_bars


def _bar(hour: int, minute: int, opened: float, high: float, low: float, close: float) -> OhlcBar:
    key = int(datetime(2026, 10, 21, hour, minute, tzinfo=IST).strftime("%Y%m%d%H%M"))
    return OhlcBar(key, opened, high, low, close, 1)


def test_open_is_not_ohlc4_or_close() -> None:
    # (100 + 140 + 90 + 130) / 4 = 115. The line is the open, 100.
    bars = [_bar(9, 20, 100, 140, 90, 130), _bar(9, 21, 200, 210, 190, 205)]
    assert open_from_bars(bars, datetime(2026, 10, 21, 9, 20, tzinfo=IST).date()) == 100


def test_a_bar_with_no_open_is_not_the_close() -> None:
    bars = [_bar(9, 20, 0, 110, 90, 105)]
    assert open_from_bars(bars, datetime(2026, 10, 21, 9, 25, tzinfo=IST).date()) is None


def test_before_0920_does_not_fetch() -> None:
    def fetch(underlying: str, now: datetime) -> list[OhlcBar]:
        raise AssertionError("no history before 09:20")

    got = get_open("NIFTY", now=datetime(2026, 10, 21, 9, 19, 59, tzinfo=IST), store={}, fetch=fetch)
    assert got["pending"] is True
    assert got["spot"] is None
    assert got["ok"] is True


def test_forming_0920_bar_locks_its_open() -> None:
    store: dict = {}
    forming = [_bar(9, 20, 22880.25, 22890, 22870, 22884)]
    got = get_open(
        "NIFTY",
        now=datetime(2026, 10, 21, 9, 20, 8, tzinfo=IST),
        store=store,
        fetch=lambda underlying, now: forming,
    )
    assert got["ok"] is True
    assert got["pending"] is False
    assert got["spot"] == 22880.25
    assert got["source"] == "09:20-open"
    assert got["minute"] == "09:20"

    def fetch(underlying: str, now: datetime) -> list[OhlcBar]:
        raise AssertionError("a locked open must not be read again")

    later = get_open("NIFTY", now=datetime(2026, 10, 21, 10, 5, tzinfo=IST), store=store, fetch=fetch)
    assert later["spot"] == 22880.25


def test_a_later_candle_cannot_replace_the_lock() -> None:
    store: dict = {}
    calls = {"n": 0}

    def fetch(underlying: str, now: datetime) -> list[OhlcBar]:
        calls["n"] += 1
        if calls["n"] == 1:
            return [_bar(9, 20, 75210.5, 75240, 75200, 75230)]
        return [_bar(9, 20, 76000, 76100, 75900, 76050), _bar(9, 21, 76100, 76200, 76000, 76150)]

    first = get_open("SENSEX", now=datetime(2026, 10, 21, 9, 20, 30, tzinfo=IST), store=store, fetch=fetch)
    second = get_open("sensex", now=datetime(2026, 10, 21, 9, 21, 5, tzinfo=IST), store=store, fetch=fetch)
    assert first["spot"] == 75210.5
    assert second["spot"] == 75210.5
    assert calls["n"] == 1


def test_nifty_and_sensex_locks_are_separate() -> None:
    store: dict = {}

    def fetch(underlying: str, now: datetime) -> list[OhlcBar]:
        opened = 22880 if underlying == "NIFTY" else 75210
        return [_bar(9, 20, opened, opened + 10, opened - 10, opened + 4)]

    nifty = get_open("NIFTY", now=datetime(2026, 10, 21, 9, 25, tzinfo=IST), store=store, fetch=fetch)
    sensex = get_open("SENSEX", now=datetime(2026, 10, 21, 9, 25, tzinfo=IST), store=store, fetch=fetch)
    assert nifty["spot"] == 22880
    assert sensex["spot"] == 75210


def test_a_missing_open_is_not_fetched_again_immediately() -> None:
    store: dict = {}
    calls = {"n": 0}

    def fetch(underlying: str, now: datetime) -> list[OhlcBar]:
        calls["n"] += 1
        return []

    now = datetime(2026, 10, 21, 9, 20, 2, tzinfo=IST)
    first = get_open("NIFTY", now=now, store=store, fetch=fetch)
    second = get_open("NIFTY", now=now, store=store, fetch=fetch)
    assert first["ok"] is False
    assert first["spot"] is None
    assert "09:20" in str(first["error"])
    assert second["error"] == first["error"]
    assert calls["n"] == 1


def test_weekend_and_other_indexes_do_not_fetch() -> None:
    def fetch(underlying: str, now: datetime) -> list[OhlcBar]:
        raise AssertionError("no fetch")

    closed = get_open("NIFTY", now=datetime(2026, 10, 18, 10, 0, tzinfo=IST), store={}, fetch=fetch)
    assert closed["pending"] is True
    assert closed["spot"] is None
    other = get_open("BANKNIFTY", now=datetime(2026, 10, 21, 10, 0, tzinfo=IST), store={}, fetch=fetch)
    assert other["ok"] is False
    assert other["spot"] is None
