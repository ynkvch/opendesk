"""tests for the risk manager endpoints (server/risk.py).

run from dashboard/:  python3 -m pytest server/tests -v

the unit tests use a fake tws. the live tests talk to the running tws on port 7496 (read-only) and are skipped when
it isn't reachable: they check the endpoints against an independent connection of their own.
"""
import asyncio
import math
import socket
from datetime import timedelta
from types import SimpleNamespace

import pytest
from scipy.stats import norm

from server import bs, risk
from server.vol import Quote, ny_today

SYMBOL = "NVDA"
LIVE_CLIENT_ID = 71  # the test's own connection, apart from the api (61), flow (47) and the journal sync (0)


def run(coro):
    return asyncio.run(coro)


# ---------- unit tests, fake tws ----------

class FakeSource:
    """stands in for TwsSource: a fixed chain, one quote per contract."""

    data_type = "live"

    def __init__(self, expiries, quotes=None):
        self.expiries = expiries
        self.quotes_by_key = quotes or {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        pass

    async def underlying(self, symbol):
        return SimpleNamespace(symbol=symbol)

    async def spot(self, und):
        return {"spot": 100.0, "close": 99.0}

    async def chain(self, und):
        return {"expiries": self.expiries, "multiplier": "100"}

    async def contracts(self, und, expiry, full):
        return [(expiry, k, r) for (e, k, r) in self.quotes_by_key if e == expiry]

    async def quotes(self, contracts):
        return [self.quotes_by_key[c] for c in contracts]


def ymd(days: int) -> str:
    return (ny_today() + timedelta(days=days)).strftime("%Y%m%d")


def test_overview_returns_every_listed_expiry_from_today_on(monkeypatch):
    listed = [ymd(d) for d in (-3, -1, 0, 1, 4, 11, 32, 95, 400)]
    monkeypatch.setattr(risk, "_source", lambda: FakeSource(listed))
    got = run(risk.overview(SYMBOL))["expiries"]
    assert [e["expiry"] for e in got] == listed[2:]  # all of them, in order, expired ones left out
    assert [e["dte"] for e in got] == [0, 1, 4, 11, 32, 95, 400]
    assert all(e["expires_at"].endswith(("T21:00:00Z", "T20:00:00Z")) for e in got)  # 16:00 new york


def quote_for(bid, ask, iv=0.45, last=None):
    e = ymd(30)
    q = Quote(e, 100.0, "C", bid, ask, last, None, None, iv, 0.5 if iv else None)
    return e, {(e, 100.0, "C"): q}


@pytest.mark.parametrize("bid,ask", [(5.10, 5.30), (0.05, 0.10), (12.0, 12.0), (1.07, 1.12)])
def test_mid_is_halfway_between_bid_and_ask(monkeypatch, bid, ask):
    e, quotes = quote_for(bid, ask)
    monkeypatch.setattr(risk, "_source", lambda: FakeSource([e], quotes))
    r = run(risk.quote(SYMBOL, e, 100.0, "C"))
    assert (r["bid"], r["ask"]) == (bid, ask)
    assert r["mid"] == pytest.approx((bid + ask) / 2, abs=1e-9)


def test_no_mid_without_both_sides(monkeypatch):
    e, quotes = quote_for(5.10, None, last=5.2)
    monkeypatch.setattr(risk, "_source", lambda: FakeSource([e], quotes))
    r = run(risk.quote(SYMBOL, e, 100.0, "C"))
    assert r["mid"] is None and r["last"] == 5.2


def test_iv_worked_out_from_the_mid_reprices_to_the_mid(monkeypatch):
    e, quotes = quote_for(4.90, 5.10, iv=None)
    monkeypatch.setattr(risk, "_source", lambda: FakeSource([e], quotes))
    r = run(risk.quote(SYMBOL, e, 100.0, "C"))
    assert r["iv_source"] == "from the mid"
    assert bs.price("C", 100.0, 100.0, 30 / 365, r["iv"]) == pytest.approx(5.00, abs=1e-6)


def scipy_price(right, s, k, t, iv, r=bs.RATE):
    d1 = (math.log(s / k) + (r + iv * iv / 2) * t) / (iv * math.sqrt(t))
    d2 = d1 - iv * math.sqrt(t)
    if right == "C":
        return s * norm.cdf(d1) - k * math.exp(-r * t) * norm.cdf(d2)
    return k * math.exp(-r * t) * norm.cdf(-d2) - s * norm.cdf(-d1)


@pytest.mark.parametrize("right", ["C", "P"])
@pytest.mark.parametrize("iv", [0.15, 0.45, 0.69, 1.1])
def test_server_black_scholes_matches_scipy(right, iv):
    for s, k, t in [(161.07, 155, 4 / 365), (100, 110, 0.5), (50, 40, 1 / 365)]:
        assert bs.price(right, s, k, t, iv) == pytest.approx(scipy_price(right, s, k, t, iv), abs=1e-6)


@pytest.mark.parametrize("ny,want", [
    ("2026-11-16 03:59", "closed"), ("2026-11-16 04:00", "pre"), ("2026-11-16 09:29", "pre"),
    ("2026-11-16 09:30", "regular"), ("2026-11-16 15:59", "regular"), ("2026-11-16 16:00", "post"),
    ("2026-11-16 19:59", "post"), ("2026-11-16 20:00", "closed"), ("2026-11-14 10:00", "closed"),
    ("2026-07-17 08:00", "pre"),
])
def test_market_session_follows_the_new_york_clock(ny, want):
    from datetime import datetime
    assert risk.market_session(datetime.fromisoformat(ny).replace(tzinfo=risk.NY)) == want


def test_market_session_converts_from_other_time_zones():
    from datetime import datetime, timezone
    # 13:00 utc on a monday in november is 08:00 new york: pre-market
    assert risk.market_session(datetime(2026, 11, 16, 13, 0, tzinfo=timezone.utc)) == "pre"


# ---------- live tests, the running tws ----------

def tws_up() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", 7496), timeout=1):
            return True
    except OSError:
        return False


live = pytest.mark.skipif(not tws_up(), reason="TWS isn't listening on port 7496")


async def tws(fn):
    """run fn(ib) on the test's own read-only tws connection, in the same event loop as the endpoint calls."""
    from ib_async import IB, Stock
    ib = IB()
    await ib.connectAsync("127.0.0.1", 7496, clientId=LIVE_CLIENT_ID, readonly=True, timeout=10)
    try:
        ib.reqMarketDataType(2)  # same as the api: live in market hours, the last values outside them
        stk = Stock(SYMBOL, "SMART", "USD")
        await ib.qualifyContractsAsync(stk)
        return await fn(ib, stk)
    finally:
        ib.disconnect()


@pytest.fixture(scope="module")
def overview():
    return run(risk.overview(SYMBOL))


@pytest.fixture(scope="module")
def contract(overview):
    """the first expiry at least a week out, and the strike nearest spot that it lists."""
    exp = next(e["expiry"] for e in overview["expiries"] if e["dte"] >= 7)
    strikes = run(risk.strikes(SYMBOL, exp))["strikes"]
    return exp, min(strikes, key=lambda k: abs(k - overview["spot"]))


@live
def test_live_every_expiry_tws_lists_is_offered(overview):
    async def listed(ib, stk):
        params = await ib.reqSecDefOptParamsAsync(SYMBOL, "", "STK", stk.conId)
        return set().union(*(p.expirations for p in params if p.exchange == "SMART"))

    today = ny_today().strftime("%Y%m%d")
    want = sorted(e for e in run(tws(listed)) if e >= today)
    got = [e["expiry"] for e in overview["expiries"]]
    missing = sorted(set(want) - set(got))
    assert not missing, f"expiries TWS lists that the page doesn't offer: {missing}"
    assert got == want


async def snapshot(ib, exp, strike, right, ticks="", want_model=False):
    from ib_async import Option
    opt = Option(SYMBOL, exp, strike, right, "SMART", currency="USD")
    await ib.qualifyContractsAsync(opt)
    t = ib.reqMktData(opt, ticks, False, False)
    for _ in range(20):
        await asyncio.sleep(0.5)
        g = t.modelGreeks
        if t.bid == t.bid and t.ask == t.ask and (not want_model or (g and g.impliedVol and g.optPrice and g.undPrice and g.vega)):
            break
    ib.cancelMktData(opt)
    return t


@live
@pytest.mark.parametrize("right", ["C", "P"])
def test_live_quote_is_the_latest_tws_quote_and_mid_is_halfway(overview, contract, right):
    exp, strike = contract

    async def both(ib, stk):
        got = await risk.quote(SYMBOL, exp, strike, right)  # the endpoint, then tws directly straight after
        t = await snapshot(ib, exp, strike, right)
        return got, t.bid, t.ask

    got, bid, ask = run(tws(both))
    assert got["bid"] is not None and got["ask"] is not None, f"no quote for {exp} {strike}{right}: {got}"
    assert got["bid"] <= got["ask"]
    # read a few seconds apart, so in market hours allow a little movement; outside them the values are frozen
    from server.vol import in_session
    tol = max(0.05, 0.25 * (ask - bid)) if in_session() else 0.0
    assert got["bid"] == pytest.approx(bid, abs=tol + 1e-9)
    assert got["ask"] == pytest.approx(ask, abs=tol + 1e-9)
    assert got["mid"] == pytest.approx((got["bid"] + got["ask"]) / 2, abs=1e-9)


@live
@pytest.mark.parametrize("right", ["C", "P"])
def test_live_black_scholes_agrees_with_the_tws_model(contract, right):
    """price and vega at tws's own iv and underlying price, against tws's option model."""
    exp, strike = contract
    t = run(tws(lambda ib, stk: snapshot(ib, exp, strike, right, "106", want_model=True)))
    g = t.modelGreeks
    if not (g and g.impliedVol and g.optPrice and g.undPrice and g.vega):
        pytest.skip("TWS sent no model price for this contract")

    from datetime import datetime, time, timezone
    from server.vol import NY, in_session, last_closed_session
    expires = datetime.fromisoformat(risk._expires_at(exp).replace("Z", "+00:00"))
    # outside market hours tws sends frozen values, priced at the last close; value at that moment too
    priced_at = datetime.now(timezone.utc) if in_session() else \
        datetime.combine(datetime.fromisoformat(last_closed_session()).date(), time(16), NY)
    years = (expires - priced_at).total_seconds() / (365 * 86400)
    ours = bs.price(right, g.undPrice, strike, years, g.impliedVol)
    # tws models dividends and its own rate curve; a flat 4.2% with no dividend lands within a few percent
    assert ours == pytest.approx(g.optPrice, rel=0.03, abs=0.03), f"ours {ours:.4f} vs TWS {g.optPrice:.4f}"
    vega = bs.greeks(right, g.undPrice, strike, years, g.impliedVol)["vega"]  # per vol point
    assert vega == pytest.approx(g.vega, rel=0.05), f"vega ours {vega:.4f} vs TWS {g.vega:.4f}"
    # a 5-point iv rise moves the price by about 5 x vega
    bump = bs.price(right, g.undPrice, strike, years, g.impliedVol + 0.05) - ours
    assert bump == pytest.approx(5 * vega, rel=0.05)
