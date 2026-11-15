"""tests for the variance risk premium history on the flow page (server/vol.py, long_history).

run from dashboard/:  python3 -m pytest server/tests/test_vrp.py -v

the unit tests use a fake tws. the live tests talk to the running tws on port 7496 (read-only) and are skipped when
it isn't reachable; the endpoint test also needs the api on port 8000.
"""
import asyncio
import json
import socket
import urllib.request
from datetime import date, timedelta

import pytest

from server import vol

SYMBOL = "AAPL"
LIVE_CLIENT_ID = 72  # the test's own connection, apart from the api (61), flow (47, 51) and the journal sync (0)
TODAY = date(2026, 11, 13)


def run(coro):
    return asyncio.run(coro)


class FakeSource:
    """answers history() from a table of durations and records what was asked for."""

    def __init__(self, answers: dict):
        self.answers = answers
        self.asked: list[str] = []

    async def history(self, und, duration="1 Y"):
        self.asked.append(duration)
        return self.answers.get(duration, ([], []))


@pytest.fixture(autouse=True)
def empty_cache(monkeypatch):
    monkeypatch.setattr(vol, "_long_history", {})


LONG = ([["2020-01-02", 0.30], ["2026-11-11", 0.25], ["2026-11-12", 0.26]],
        [["2020-01-02", 0.20], ["2026-11-11", 0.24], ["2026-11-12", 0.27]])
RECENT = ([["2026-11-12", 0.28], ["2026-11-13", 0.29]],
          [["2026-11-13", 0.31]])


def test_first_read_of_the_day_pulls_ten_years():
    src = FakeSource({"10 Y": LONG})
    iv, rv = run(vol.long_history(src, None, SYMBOL, TODAY))
    assert src.asked == ["10 Y"]
    assert (iv, rv) == LONG


def test_later_reads_only_pull_recent_days_and_lay_them_over():
    src = FakeSource({"10 Y": LONG, "5 D": RECENT})
    run(vol.long_history(src, None, SYMBOL, TODAY))
    iv, rv = run(vol.long_history(src, None, SYMBOL, TODAY))
    assert src.asked == ["10 Y", "5 D"]
    # the 12th's implied is replaced by the newer read, the 13th is added, and the old years are kept
    assert iv == [["2020-01-02", 0.30], ["2026-11-11", 0.25], ["2026-11-12", 0.28], ["2026-11-13", 0.29]]
    assert rv == [["2020-01-02", 0.20], ["2026-11-11", 0.24], ["2026-11-12", 0.27], ["2026-11-13", 0.31]]


def test_the_merged_history_is_kept_for_the_next_read():
    src = FakeSource({"10 Y": LONG, "5 D": RECENT})
    for _ in range(3):
        iv, _ = run(vol.long_history(src, None, SYMBOL, TODAY))
    assert src.asked == ["10 Y", "5 D", "5 D"]
    assert [d for d, _ in iv] == sorted({d for d, _ in iv}), "dates stay sorted and unique"


def test_a_new_day_pulls_ten_years_again():
    src = FakeSource({"10 Y": LONG, "5 D": RECENT})
    run(vol.long_history(src, None, SYMBOL, TODAY))
    run(vol.long_history(src, None, SYMBOL, TODAY + timedelta(days=1)))
    assert src.asked == ["10 Y", "10 Y"]


def test_falls_back_to_one_year_when_the_long_pull_is_refused():
    one_year = ([["2026-01-02", 0.3]], [["2026-01-02", 0.2]])
    src = FakeSource({"1 Y": one_year})
    assert run(vol.long_history(src, None, SYMBOL, TODAY)) == one_year
    assert src.asked == ["10 Y", "1 Y"]


def test_nothing_is_kept_when_tws_returns_nothing():
    src = FakeSource({})
    assert run(vol.long_history(src, None, SYMBOL, TODAY)) == ([], [])
    run(vol.long_history(src, None, SYMBOL, TODAY))
    assert src.asked == ["10 Y", "1 Y", "10 Y", "1 Y"], "an empty answer is asked for again, not cached"


def test_symbols_are_kept_apart():
    src = FakeSource({"10 Y": LONG, "5 D": RECENT})
    run(vol.long_history(src, None, "AAPL", TODAY))
    run(vol.long_history(src, None, "NVDA", TODAY))
    assert src.asked == ["10 Y", "10 Y"]


# ---------- live tests, the running tws ----------

def port_up(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


live = pytest.mark.skipif(not port_up(7496), reason="TWS isn't listening on port 7496")


async def own_bars(duration: str) -> tuple[list, list]:
    """implied and historical vol bars from the test's own read-only connection, independent of vol.py."""
    from ib_async import IB, Stock
    ib = IB()
    await ib.connectAsync("127.0.0.1", 7496, clientId=LIVE_CLIENT_ID, readonly=True, timeout=10)
    try:
        stk = Stock(SYMBOL, "SMART", "USD")
        await ib.qualifyContractsAsync(stk)
        out = []
        for what in ("OPTION_IMPLIED_VOLATILITY", "HISTORICAL_VOLATILITY"):
            bars = await ib.reqHistoricalDataAsync(stk, "", duration, "1 day", what, True, 1)
            out.append({b.date.isoformat()[:10]: b.close for b in bars if b.close and b.close > 0})
        return out[0], out[1]
    finally:
        ib.disconnect()


async def via_vol(times: int = 1):
    """long_history through vol.py's own tws source, read `times` times on one connection."""
    async with vol.TwsSource(client_id=LIVE_CLIENT_ID + 1) as src:
        und = await src.underlying(SYMBOL)
        return [await vol.long_history(src, und, SYMBOL, vol.ny_today()) for _ in range(times)]


@pytest.fixture(scope="module")
def reads():
    vol._long_history.clear()
    return run(via_vol(times=2))


@live
def test_live_history_reaches_back_well_over_a_year(reads):
    iv, rv = reads[0]
    first = date.fromisoformat(iv[0][0])
    assert (vol.ny_today() - first).days > 2 * 365, f"implied vol only goes back to {first}"
    assert len(iv) > 2 * 252 and len(rv) > 2 * 252


@live
def test_live_history_is_sorted_recent_and_plausible(reads):
    for series in reads[1]:
        days = [d for d, _ in series]
        assert days == sorted(set(days)), "sorted, one value a day"
        assert (vol.ny_today() - date.fromisoformat(days[-1])).days <= 5, "ends in the last few days"
        assert all(0.01 < v < 3 for _, v in series), "annualised vol between 1% and 300%"


@live
def test_live_top_up_keeps_the_long_history(reads):
    (iv1, rv1), (iv2, rv2) = reads
    assert len(iv2) >= len(iv1) and len(rv2) >= len(rv1)
    assert iv2[0] == iv1[0], "the oldest day survives the top-up"


@live
def test_live_values_match_an_independent_tws_request(reads):
    iv, rv = reads[1]
    own_iv, own_rv = run(own_bars("1 Y"))
    # the last bar can move during the session, so compare finished days only
    shared = [d for d, _ in iv[:-1] if d in own_iv][-60:]
    assert len(shared) >= 50
    mine_iv, mine_rv = dict(iv), dict(rv)
    for d in shared:
        assert mine_iv[d] == pytest.approx(own_iv[d], abs=1e-9), d
        if d in own_rv:
            assert mine_rv[d] == pytest.approx(own_rv[d], abs=1e-9), d


@pytest.mark.skipif(not (port_up(7496) and port_up(8000)), reason="needs TWS on 7496 and the api on 8000")
def test_live_endpoint_sends_the_long_history():
    with urllib.request.urlopen(f"http://127.0.0.1:8000/api/vol/{SYMBOL}?live=false", timeout=240) as r:
        data = json.load(r)
    iv, rv = data["history"]["iv"], data["history"]["rv"]
    assert (vol.ny_today() - date.fromisoformat(iv[0][0])).days > 2 * 365
    # the page's vrp: implied minus realized on shared days, in vol points
    realized = dict(rv)
    vrp = [(d, (v - realized[d]) * 100) for d, v in iv if d in realized]
    assert len(vrp) > 2 * 252
    assert all(-100 < x < 100 for _, x in vrp), "a vrp beyond 100 vol points would be a unit mistake"
