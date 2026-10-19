"""ATP merge: touchline (1501) must beat market-depth (1502) ATP; LTP follows 1501 tape."""
from __future__ import annotations

from xts_md import _coalesce_merge_ticks, _touchline_derived_price


def test_1502_does_not_clobber_1501_atp() -> None:
    prev = {"messageCode": 1501, "ltp": 238.05, "atp": 219.09, "exchangeInstrumentID": 1, "ts": 1000.0}
    new = {"messageCode": 1502, "ltp": 238.10, "atp": 194.81, "exchangeInstrumentID": 1, "ts": 1000.001}
    out = _coalesce_merge_ticks(prev, new)
    assert abs(float(out["ltp"]) - 238.05) < 1e-6
    assert abs(float(out["atp"]) - 219.09) < 1e-6
    assert abs(float(out["_atp1501"]) - 219.09) < 1e-6
    assert abs(float(out["_atp1502"]) - 194.81) < 1e-6


def test_1501_atp_updates_over_1502() -> None:
    prev = {"messageCode": 1502, "ltp": 238.0, "atp": 194.81, "exchangeInstrumentID": 1}
    new = {"messageCode": 1501, "ltp": 238.05, "atp": 219.09, "exchangeInstrumentID": 1}
    out = _coalesce_merge_ticks(prev, new)
    assert abs(float(out["atp"]) - 219.09) < 1e-6


def test_1502_atp_updates_when_no_1501() -> None:
    prev = {"messageCode": 1502, "ltp": 238.0, "atp": 210.0, "exchangeInstrumentID": 1}
    new = {"messageCode": 1502, "ltp": 238.5, "atp": 211.5, "exchangeInstrumentID": 1}
    out = _coalesce_merge_ticks(prev, new)
    assert abs(float(out["atp"]) - 211.5) < 1e-6


def test_1501_ltp_not_replaced_by_stale_1502() -> None:
    now = 1_700_000_000.0
    prev = {
        "messageCode": 1501,
        "ltp": 99.0,
        "atp": 101.10,
        "exchangeInstrumentID": 1,
        "ts": now,
        "_ltp1501": 99.0,
        "_ltp1501_ts": now,
    }
    new = {
        "messageCode": 1502,
        "ltp": 105.0,
        "bid": 98.95,
        "ask": 99.10,
        "atp": 101.10,
        "exchangeInstrumentID": 1,
        "ts": now + 0.001,
    }
    out = _coalesce_merge_ticks(prev, new)
    assert abs(float(out["ltp"]) - 99.0) < 1e-6
    assert abs(float(out["atp"]) - 101.10) < 1e-6
    assert abs(float(out["bid"]) - 98.95) < 1e-6
    assert abs(float(out["ask"]) - 99.10) < 1e-6


def test_derived_price_does_not_use_day_high() -> None:
    px = _touchline_derived_price(
        {
            "LastTradedPrice": 0,
            "High": 105.0,
            "Close": 98.5,
            "AverageTradedPrice": 102.0,
        }
    )
    assert px is not None and abs(float(px) - 98.5) < 1e-6


def test_derived_price_prefers_last_trade() -> None:
    px = _touchline_derived_price({"LastTradedPrice": 99.0, "High": 105.0, "Close": 98.5})
    assert px is not None and abs(float(px) - 99.0) < 1e-6
