"""volatility and options flow for one ticker, read from tws (read-only).

GET /api/vol/{symbol} returns, in one tws session:
  - spot, and two years of tws's own 30-day implied and historical (realized) volatility for the ticker
  - the term structure: at-the-money iv for each expiry out to about a year
  - the skew at 10, 15 and 25 delta, both sides, for the expiries nearest 30, 60 and 90 days
  - the 30-60 day forward factor: how the 30-day option is priced against the 30-60 day forward window
  - the flow: today's volume, open interest and premium for every contract near the money in the nearest
    expiries, and how much traded since the previous load

tws keeps no history of an option chain, so the skew and forward factor history is built here: one snapshot a
day per ticker in data/vol.db, written whenever the ticker is loaded and by the daily job for the watchlist.

VOL_SOURCE=sim swaps tws for a made-up chain, for working on the page without tws open.

run:  python3 -m server.vol NVDA          # print a summary for one ticker
      python3 -m server.vol --watchlist   # snapshot every ticker on the watchlist (the daily job does this)
"""
import argparse
import asyncio
import json
import math
import os
import random
import sqlite3
import time as clock
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException

from . import bs

# made-up data never mixes with real snapshots
DB_PATH = Path(__file__).resolve().parent.parent / "data" / ("vol_sim.db" if os.environ.get("VOL_SOURCE") == "sim" else "vol.db")
NY = ZoneInfo("America/New_York")
PORT = int(os.environ.get("TWS_PORT", "7496"))
CLIENT_ID = 47  # the journal sync uses 0; this one must differ so both can be connected at once
BATCH = 80  # market data lines per batch; tws allows 100 at once, and the journal sync may hold a few
WAIT = 2.5  # seconds to let the underlying's quote arrive
BATCH_WAIT = 8.0  # at most this long for a batch of option quotes; most fill in 3 to 5 seconds
FLOW_DAYS = 45  # expiries this close are in the flow
FLOW_WIDTH = 0.15  # strikes within this fraction of spot are in the flow
FLOW_MAX_STRIKES = 30  # per flow expiry, nearest the money
SWEEP_PER_READ = 320  # the rest of the chain is read in slices of this many contracts, one slice per read
SWEEP_NEW_EXPIRIES = 2  # whole-expiry lookups per read for the sweep (about 5 s each the first time)
CACHE_SECONDS = 120  # a load answers from memory this long without an open page asking
LIVE_EVERY = 60  # while the page is open, tws is read again this often (seconds)
ACTIVE_FOR = 90  # a ticker counts as open while the page asked about it this recently
HISTORY_RETRY = 30 * 60  # after a history build, wait at least this long before the next one
HISTORY_SESSIONS = 5
HISTORY_CLIENT_ID = 51  # its own connection, so the slow bar requests don't hold up the minute-by-minute read
TERM_TARGETS = [7, 14, 21, 30, 45, 60, 90, 120, 180, 270, 365]
SKEW_TENORS = [30, 60, 90]
DELTAS = [0.10, 0.15, 0.25]
BUCKETS = ["10Δ put", "15Δ put", "25Δ put", "ATM", "25Δ call", "15Δ call", "10Δ call"]
NO_SUBSCRIPTION = {354, 10089, 10090, 10167, 10168, 10197}

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    symbol  TEXT NOT NULL,
    date    TEXT NOT NULL,          -- new york session date
    time    TEXT NOT NULL,          -- iso utc of the load that wrote it; the day's last load wins
    spot    REAL,
    atm30   REAL, atm60 REAL, atm90 REAL,
    skew25  REAL,                   -- 30-day 25-delta call iv minus put iv, vol points
    ff      REAL,                   -- 30-60 day forward factor, fraction
    term    TEXT NOT NULL,          -- json [{expiry, dte, iv}]
    skew    TEXT NOT NULL,          -- json [{label, dte, values}]
    PRIMARY KEY (symbol, date)
);
-- running totals through the session, for the intraday call and put premium chart
CREATE TABLE IF NOT EXISTS flow_points (
    symbol        TEXT NOT NULL,
    time          TEXT NOT NULL,
    call_volume   REAL NOT NULL, put_volume REAL NOT NULL,
    call_premium  REAL NOT NULL, put_premium REAL NOT NULL,
    PRIMARY KEY (symbol, time)
);
-- an expiry's listed contracts, so tws's slow whole-expiry lookup happens once per ticker every two days
CREATE TABLE IF NOT EXISTS option_contracts (
    symbol    TEXT NOT NULL,
    expiry    TEXT NOT NULL,
    fetched   TEXT NOT NULL,          -- new york date of the lookup
    contracts TEXT NOT NULL,          -- json [[conId, strike, right, tradingClass, multiplier]]
    PRIMARY KEY (symbol, expiry)
);
-- open interest changes once a day, but tws only sometimes sends it, so each contract's last figure is kept
CREATE TABLE IF NOT EXISTS option_oi (
    symbol  TEXT NOT NULL,
    expiry  TEXT NOT NULL,
    strike  REAL NOT NULL,
    right   TEXT NOT NULL,
    oi      REAL NOT NULL,
    date    TEXT NOT NULL,           -- new york date it was received
    PRIMARY KEY (symbol, expiry, strike, right)
);
-- 30-minute trade bars per option contract, from tws's historical data: past sessions' flow
CREATE TABLE IF NOT EXISTS option_bars (
    symbol  TEXT NOT NULL,
    expiry  TEXT NOT NULL,
    strike  REAL NOT NULL,
    right   TEXT NOT NULL,
    time    TEXT NOT NULL,           -- bar start, iso utc
    day     TEXT NOT NULL,           -- new york session date
    close   REAL NOT NULL,
    volume  REAL NOT NULL,
    PRIMARY KEY (symbol, expiry, strike, right, time)
);
CREATE TABLE IF NOT EXISTS underlying_bars (
    symbol  TEXT NOT NULL,
    time    TEXT NOT NULL,
    day     TEXT NOT NULL,
    close   REAL NOT NULL,
    PRIMARY KEY (symbol, time)
);
CREATE TABLE IF NOT EXISTS watchlist (
    symbol      TEXT PRIMARY KEY,
    added_at    TEXT NOT NULL,
    last_viewed TEXT NOT NULL
);
"""


class VolError(Exception):
    """something the page should show as a plain message, with the http status to send."""

    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.status = status


@dataclass
class Quote:
    expiry: str  # YYYYMMDD
    strike: float
    right: str  # C | P
    bid: float | None
    ask: float | None
    last: float | None
    volume: float | None
    oi: float | None
    iv: float | None
    delta: float | None


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ny_today() -> date:
    return datetime.now(NY).date()


def connect_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def clean(v) -> float | None:
    """tws marks a missing value as nan or -1."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or f < 0 else f


def dte_of(expiry: str, today: date) -> int:
    return (datetime.strptime(expiry, "%Y%m%d").date() - today).days


# ---------- sources ----------

class TwsSource:
    """reads everything from a running tws or ib gateway over its read-only api."""

    name = "tws"

    def __init__(self):
        from ib_async import IB
        self.ib = IB()
        self.errors: set[int] = set()
        self.missing: set[tuple] = set()  # (expiry, strike, right) that tws says don't exist
        self.data_type = "live"

    async def __aenter__(self):
        last = None
        for cid in (CLIENT_ID, CLIENT_ID + 1, CLIENT_ID + 2):
            try:
                await self.ib.connectAsync("127.0.0.1", PORT, clientId=cid, readonly=True, timeout=6)
                break
            except Exception as e:  # refused, timed out, or the client id is taken
                last = e
                self.ib.disconnect()
        if not self.ib.isConnected():
            raise VolError(f"TWS isn't reachable on port {PORT}. Open TWS, log in, and enable the API "
                           f"(Global Configuration > API > Settings). ({last})")
        self.ib.errorEvent += self._on_error
        # 2 = frozen: live in market hours, the last recorded values outside them
        self.ib.reqMarketDataType(2)
        return self

    async def __aexit__(self, *exc):
        self.ib.disconnect()

    def _on_error(self, req, code, msg, contract):
        self.errors.add(code)
        if code == 200 and contract is not None and getattr(contract, "secType", "") == "OPT":
            # no security definition: that strike isn't listed for that expiry
            self.missing.add((contract.lastTradeDateOrContractMonth[:8], float(contract.strike), contract.right))

    async def underlying(self, symbol: str):
        from ib_async import Index, Stock
        for c in (Stock(symbol, "SMART", "USD"), Index(symbol, "CBOE", "USD")):
            q = await self.ib.qualifyContractsAsync(c)
            if q and q[0] and q[0].conId:
                return q[0]
        raise VolError(f"TWS doesn't know a US stock, ETF or index called {symbol}.", 404)

    async def spot(self, und) -> dict:
        t = self.ib.reqMktData(und, "100,101,104,106", False, False)
        await asyncio.sleep(WAIT)
        self.ib.cancelMktData(und)
        price = clean(t.marketPrice()) or clean(t.last) or clean(t.close)
        self._spot = price
        if price is None and self.errors & NO_SUBSCRIPTION:
            self.ib.reqMarketDataType(4)  # no live subscription: fall back to delayed
            self.data_type = "delayed"
            t = self.ib.reqMktData(und, "100,101,104,106", False, False)
            await asyncio.sleep(WAIT + 1)
            self.ib.cancelMktData(und)
            price = clean(t.marketPrice()) or clean(t.last) or clean(t.close)
            self._spot = price
        if price is None:
            raise VolError("TWS returned no price for this ticker. Check its market data subscriptions.")
        return {"spot": price, "close": clean(t.close), "iv": clean(t.impliedVolatility),
                "hv": clean(t.histVolatility), "call_volume": clean(t.callVolume), "put_volume": clean(t.putVolume),
                "call_oi": clean(t.callOpenInterest), "put_oi": clean(t.putOpenInterest)}

    async def history(self, und) -> tuple[list, list]:
        async def one(what: str):
            try:
                bars = await self.ib.reqHistoricalDataAsync(und, "", "1 Y", "1 day", what, True, 1)
            except Exception:
                return []
            return [[b.date.isoformat()[:10], b.close] for b in bars if b.close and b.close > 0]
        iv, rv = await asyncio.gather(one("OPTION_IMPLIED_VOLATILITY"), one("HISTORICAL_VOLATILITY"))
        return iv, rv

    async def chain(self, und) -> dict:
        params = await self.ib.reqSecDefOptParamsAsync(und.symbol, "", und.secType, und.conId)
        smart = [p for p in params if p.exchange == "SMART"] or params
        if not smart:
            raise VolError(f"TWS lists no options for {und.symbol}.", 404)
        # the main class (SPX, not SPXW) has the longest expiries; take the one with the most of them
        main = max(smart, key=lambda p: (p.tradingClass == und.symbol, len(p.expirations)))
        self._main = main
        return {"expiries": sorted(main.expirations), "classes": {p.tradingClass for p in smart}, "multiplier": main.multiplier}

    async def contracts(self, und, expiry: str, full: bool) -> list:
        """the option contracts of one expiry.

        full: every listed strike, for the skew and flow expiries. tws paces whole-expiry lookups at about 5 s each,
        so the answer is kept in vol.db for two days and the lookup only happens on a ticker's first load.
        otherwise: just the strikes around the money, for the term structure. those are named from the chain's
        strike list and qualified, keeping the ones that exist, which takes about a second."""
        from ib_async import Option
        m = self._main
        if full:
            cached = cached_contracts(und.symbol, expiry)
            if cached is not None:
                return [Option(und.symbol, expiry, k, r, "SMART", mult, "USD", tradingClass=tc, conId=cid)
                        for cid, k, r, tc, mult in cached]
            details = await self.ib.reqContractDetailsAsync(Option(und.symbol, expiry, exchange="SMART", currency="USD"))
            found = [d.contract for d in details if d.contract.secType == "OPT"]
            store_contracts(und.symbol, expiry, [(c.conId, float(c.strike), c.right, c.tradingClass, c.multiplier) for c in found])
            return found
        near = sorted(m.strikes, key=lambda k: abs(k - self._spot))[:8]
        guesses = [Option(und.symbol, expiry, k, r, "SMART", m.multiplier, "USD", tradingClass=m.tradingClass)
                   for k in near for r in ("C", "P")]
        return [c for c in await self.ib.qualifyContractsAsync(*guesses) if c and c.conId]

    async def quotes(self, contracts: list) -> list[Quote]:
        out: list[Quote] = []
        for i in range(0, len(contracts), BATCH):
            batch = contracts[i:i + BATCH]
            tickers = [self.ib.reqMktData(c, "101", False, False) for c in batch]
            # quotes trickle in over a few seconds: wait until nearly every contract has a price, then a little
            # longer for the model greeks, which come last
            start = clock.monotonic()
            while clock.monotonic() - start < BATCH_WAIT:
                await asyncio.sleep(0.5)
                gone = sum(1 for c in batch if (c.lastTradeDateOrContractMonth[:8], float(c.strike), c.right) in self.missing)
                priced = sum(1 for t in tickers if clean(t.bid) or clean(t.close) or clean(t.last))
                if priced >= 0.95 * (len(batch) - gone):
                    await asyncio.sleep(1.5)  # greeks and open interest arrive after the prices
                    break
            for c, t in zip(batch, tickers):
                g = t.modelGreeks
                oi = t.callOpenInterest if c.right == "C" else t.putOpenInterest
                out.append(Quote(c.lastTradeDateOrContractMonth[:8], float(c.strike), c.right, clean(t.bid), clean(t.ask),
                                 clean(t.last), clean(t.volume), clean(oi), clean(g.impliedVol) if g else None,
                                 g.delta if g and g.delta is not None and not math.isnan(g.delta) else None))
                self.ib.cancelMktData(c)
        return out


class SimSource:
    """a made-up chain with a smile, a term structure and random volume, so the page works without tws."""

    name = "sim"
    data_type = "simulated"

    def __init__(self):
        self.symbol = ""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        pass

    def _rng(self, salt: str = "") -> random.Random:
        return random.Random(f"{self.symbol}:{ny_today()}:{salt}")

    def _iv(self, k: float, s: float, days: float) -> float:
        base = 0.25 + (sum(map(ord, self.symbol)) % 20) / 100
        m = math.log(k / s) / math.sqrt(max(days, 1) / 365)
        return max(0.05, base * (1 + 0.12 * math.log1p(days / 30)) - 0.035 * m + 0.03 * m * m)

    async def underlying(self, symbol: str):
        self.symbol = symbol
        return symbol

    async def spot(self, und) -> dict:
        s = 20 + (sum(map(ord, self.symbol)) * 37) % 600
        s *= 1 + 0.002 * math.sin(clock.time() / 600)
        return {"spot": round(s, 2), "close": round(s * 0.99, 2), "iv": self._iv(s, s, 30), "hv": self._iv(s, s, 30) * 0.85,
                "call_volume": None, "put_volume": None, "call_oi": None, "put_oi": None}

    async def history(self, und) -> tuple[list, list]:
        rng = self._rng("hist")
        d, iv, rv, a, b = ny_today() - timedelta(days=730), [], [], 0.0, 0.0
        base = self._iv(100, 100, 30)
        while d <= ny_today():
            if d.weekday() < 5:
                a += -0.04 * a + rng.gauss(0, 0.012)
                b += -0.02 * b + rng.gauss(0, 0.009)
                iv.append([d.isoformat(), round(max(0.05, base + a), 4)])
                rv.append([d.isoformat(), round(max(0.04, base * 0.85 + b), 4)])
            d += timedelta(days=1)
        return iv, rv

    async def chain(self, und) -> dict:
        t, out = ny_today(), []
        d = t + timedelta(days=1)
        while (d - t).days <= 400:
            if d.weekday() == 4 and ((d - t).days <= 60 or 15 <= d.day <= 21):
                out.append(d.strftime("%Y%m%d"))
            d += timedelta(days=1)
        return {"expiries": out, "classes": {self.symbol}, "multiplier": "100"}

    async def contracts(self, und, expiry: str, full: bool = True) -> list:
        s = (await self.spot(und))["spot"]
        step = 1 if s < 60 else 2.5 if s < 150 else 5 if s < 500 else 10
        lo, hi = s * 0.5, s * 1.6
        k = math.floor(lo / step) * step
        out = []
        while k <= hi:
            out += [(expiry, k, "C"), (expiry, k, "P")]
            k += step
        return out

    async def quotes(self, contracts: list) -> list[Quote]:
        s = (await self.spot(None))["spot"]
        today = ny_today()
        out = []
        for expiry, k, right in contracts:
            days = max(dte_of(expiry, today), 0.5)
            iv = self._iv(k, s, days)
            t = days / 365
            p = bs.price(right, s, k, t, iv)
            g = bs.greeks(right, s, k, t, iv)
            rng = self._rng(f"{expiry}{k}{right}")
            near = math.exp(-abs(math.log(k / s)) / (0.05 + 0.15 * math.sqrt(t)))
            vol = int(rng.lognormvariate(0, 1) * 1500 * near / (1 + days / 20)) if p > 0.02 else 0
            vol += int((clock.time() % 3600) / 3600 * vol * 0.3)  # volume grows through the hour
            spread = max(0.01, p * 0.03)
            out.append(Quote(expiry, k, right, round(max(p - spread, 0), 2), round(p + spread, 2),
                             round(p + rng.choice([-1, 1]) * spread, 2), vol, int(vol * rng.uniform(0.6, 8)),
                             iv, g["delta"]))
        return out


def make_source():
    return SimSource() if os.environ.get("VOL_SOURCE") == "sim" else TwsSource()


# ---------- maths ----------

def interp(x: float, pts: list[tuple[float, float]]) -> float | None:
    """linear interpolation inside the points' x range; none outside it."""
    pts = sorted(pts)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return None


def fill_iv(q: Quote, spot: float, days: int) -> Quote:
    """when tws sends no model greeks, work iv and delta out from the mid price."""
    if q.iv is not None and q.delta is not None:
        return q
    mid = (q.bid + q.ask) / 2 if q.bid and q.ask else q.last
    t = max(days, 0.5) / 365
    if mid:
        iv = bs.implied_vol(q.right, mid, spot, q.strike, t)
        if iv:
            q.iv = q.iv or iv
            q.delta = q.delta if q.delta is not None else bs.greeks(q.right, spot, q.strike, t, iv)["delta"]
    return q


def atm_iv(quotes: list[Quote], spot: float) -> float | None:
    """at-the-money iv of one expiry: calls and puts each interpolated to the spot strike, then averaged."""
    vals = []
    for right in ("C", "P"):
        pts = [(q.strike, q.iv) for q in quotes if q.right == right and q.iv]
        v = interp(spot, pts)
        if v is None and pts:
            near = min(pts, key=lambda p: abs(p[0] - spot))
            v = near[1] if abs(near[0] - spot) / spot < 0.03 else None
        if v is not None:
            vals.append(v)
    return sum(vals) / len(vals) if vals else None


def iv_at(days: float, term: list[dict]) -> float | None:
    """atm iv at a fixed horizon, interpolating total variance (iv² × time) between expiries."""
    pts = [(t["dte"], t["iv"] ** 2 * t["dte"]) for t in term if t["iv"] and t["dte"] > 0]
    w = interp(days, pts)
    return math.sqrt(w / days) if w and w > 0 else None


def forward_factor(term: list[dict]) -> dict:
    a, b = iv_at(30, term), iv_at(60, term)
    if not a or not b:
        return {"value": None, "iv30": a, "iv60": b, "forward": None}
    var = (b * b * 60 - a * a * 30) / 30
    fwd = math.sqrt(var) if var > 0 else None
    return {"value": a / fwd - 1 if fwd else None, "iv30": a, "iv60": b, "forward": fwd}


def skew_values(quotes: list[Quote], spot: float) -> list[float | None]:
    """iv at 10, 15 and 25 delta puts, atm, then 25, 15, 10 delta calls, from out-of-the-money options."""
    puts = [(-q.delta, q.iv) for q in quotes if q.right == "P" and q.iv and q.delta is not None and q.strike <= spot * 1.01]
    calls = [(q.delta, q.iv) for q in quotes if q.right == "C" and q.iv and q.delta is not None and q.strike >= spot * 0.99]
    return ([interp(d, puts) for d in DELTAS] + [atm_iv(quotes, spot)] + [interp(d, calls) for d in reversed(DELTAS)])


def percentile(cur: float, xs: list[float]) -> float | None:
    return sum(x < cur for x in xs) / len(xs) if xs and cur is not None else None


# ---------- collection ----------

def pick_expiries(expiries: list[str], today: date) -> dict:
    live = [e for e in expiries if dte_of(e, today) >= 1]
    by_dte = {e: dte_of(e, today) for e in live}
    near = lambda target: min(live, key=lambda e: abs(by_dte[e] - target)) if live else None
    term = sorted({near(t) for t in TERM_TARGETS if near(t) and by_dte[near(t)] <= 420}, key=by_dte.get)
    skew = {t: near(t) for t in SKEW_TENORS if near(t)}
    flow = [e for e in live if by_dte[e] <= FLOW_DAYS][:6]
    return {"term": term, "skew": skew, "flow": flow, "dte": by_dte}


def strike_of(c) -> float:
    return float(c[1]) if isinstance(c, tuple) else float(c.strike)


def right_of(c) -> str:
    return c[2] if isinstance(c, tuple) else c.right


def choose(contracts: list, spot: float, iv: float, days: int, role: set[str]) -> list:
    """the contracts of one expiry worth quoting, given what the expiry is used for."""
    keep = []
    strikes = sorted({strike_of(c) for c in contracts})
    if not strikes:
        return []
    width = max(0.08, 3.2 * iv * math.sqrt(max(days, 1) / 365))  # out to roughly the 10-delta strikes
    nearest = sorted(strikes, key=lambda k: abs(k - spot))
    want: set[float] = set(nearest[:4])  # around the money, for the term structure
    if "skew" in role:
        inside = [k for k in strikes if abs(k / spot - 1) <= width]
        step = max(1, len(inside) // 28)
        want |= set(inside[::step])
    if "flow" in role:
        inside = sorted((k for k in strikes if abs(k / spot - 1) <= FLOW_WIDTH), key=lambda k: abs(k - spot))
        want |= set(inside[:FLOW_MAX_STRIKES])
    for c in contracts:
        k, r = strike_of(c), right_of(c)
        if k not in want:
            continue
        # the skew only reads out-of-the-money options; the flow wants both sides of every strike
        otm = (r == "P" and k <= spot * 1.02) or (r == "C" and k >= spot * 0.98)
        if "flow" in role or k in nearest[:4] or otm:
            keep.append(c)
    return keep


def key_of(c) -> tuple:
    if isinstance(c, tuple):
        return (c[0], float(c[1]), c[2])
    return (c.lastTradeDateOrContractMonth[:8], float(c.strike), c.right)


_sweep: dict[str, dict] = {}  # symbol -> {cursor, lists: {expiry: contracts}, universe, expiries, expiries_known}
_book: dict[str, dict] = {}  # symbol -> {day, rows: {key: row}}: every contract read today and its latest figures


async def sweep_slice(src, und, symbol: str, expiries: list[str], today: date, core: set) -> list:
    """the next slice of the whole chain, in rotation, so every listed contract is read every so often and the flow
    totals count every contract that traded, not only those near the money. expiries whose contract lists aren't
    cached yet are looked up a couple per read, since tws takes about 5 s for each."""
    st = _sweep.setdefault(symbol, {"cursor": 0, "lists": {}})
    live = [e for e in expiries if dte_of(e, today) >= 0]
    looked = 0
    for e in live:
        if e in st["lists"]:
            continue
        if not isinstance(src, SimSource) and cached_contracts(symbol, e) is None:
            if looked >= SWEEP_NEW_EXPIRIES:
                continue
            looked += 1
        st["lists"][e] = await src.contracts(und, e, True)
    universe = [c for e in live if e in st["lists"] for c in st["lists"][e] if key_of(c) not in core]
    st.update(universe=len(universe) + len(core), expiries=len(live), expiries_known=sum(e in st["lists"] for e in live))
    if not universe:
        return []
    i = st["cursor"] % len(universe)
    part = (universe[i:] + universe[:i])[:SWEEP_PER_READ]
    st["cursor"] = i + len(part)
    return part


async def collect(symbol: str, previous: dict | None = None) -> dict:
    symbol = symbol.upper().strip()
    today = ny_today()
    started = clock.time()
    async with make_source() as src:
        und = await src.underlying(symbol)
        quote = await src.spot(und)
        spot = quote["spot"]
        (hist_iv, hist_rv), chain = await asyncio.gather(src.history(und), src.chain(und))
        picks = pick_expiries(chain["expiries"], today)
        roles: dict[str, set[str]] = {}
        for e in picks["term"]:
            roles.setdefault(e, set()).add("term")
        for e in picks["skew"].values():
            roles.setdefault(e, set()).add("skew")
        for e in picks["flow"]:
            roles.setdefault(e, set()).add("flow")
        guess = quote["iv"] or (hist_iv[-1][1] if hist_iv else 0.35)
        # one expiry at a time: tws answers concurrent contract lookups five seconds apart, one at a time takes 0.1 s
        per_expiry = [await src.contracts(und, e, bool(roles[e] & {"skew", "flow"})) for e in roles]
        wanted = []
        for e, cs in zip(roles, per_expiry):
            wanted += choose(cs, spot, guess, picks["dte"][e], roles[e])
        core = {key_of(c) for c in wanted}
        sweep = await sweep_slice(src, und, symbol, chain["expiries"], today, core)
        quotes = [fill_iv(q, spot, dte_of(q.expiry, today)) for q in await src.quotes(wanted + sweep)]
        data_type = src.data_type

    by_exp: dict[str, list[Quote]] = {}
    for q in quotes:
        by_exp.setdefault(q.expiry, []).append(q)
    term = [{"expiry": e, "dte": picks["dte"][e], "iv": atm_iv(by_exp.get(e, []), spot)} for e in picks["term"]]
    term = [t for t in term if t["iv"]]
    skew = [{"label": f"{t}d", "expiry": e, "dte": picks["dte"][e], "values": skew_values(by_exp.get(e, []), spot)}
            for t, e in picks["skew"].items()]
    first = skew[0]["values"] if skew else [None] * 7
    skew25 = (first[4] - first[2]) * 100 if first[4] and first[2] else None
    ff = forward_factor(term)

    # flow: every contract read today keeps its latest figures, so the totals cover the whole chain once the sweep
    # has gone round; volume is today's, so the book starts afresh each new york day
    stamp = now_iso()
    book = _book.get(symbol)
    if not book or book["day"] != today.isoformat():
        book = _book[symbol] = {"day": today.isoformat(), "rows": {}}
    near = {(q.expiry, q.strike, q.right) for e in picks["flow"] for q in by_exp.get(e, [])}
    fresh = []
    for q in quotes:
        key = (q.expiry, q.strike, q.right)
        price = (q.bid + q.ask) / 2 if q.bid and q.ask else q.last
        vol = q.volume or 0
        side = None
        if q.last and q.bid and q.ask:
            side = "ask" if q.last >= q.ask else "bid" if q.last <= q.bid else "mid"
        prev = book["rows"].get(key)
        fresh.append({**asdict(q), "dte": dte_of(q.expiry, today), "volume": vol, "price": price,
                      "premium": vol * (price or 0) * 100, "side": side, "read_at": stamp,
                      "new": None if prev is None else max(0, vol - prev["volume"])})
    known_oi = remember_oi(symbol, fresh, today)
    last_session = previous_session_volume(symbol, today)
    for r in fresh:
        key = (r["expiry"], r["strike"], r["right"])
        r["oi_date"] = today.isoformat() if r["oi"] is not None else None
        if r["oi"] is None and key in known_oi:
            r["oi"], r["oi_date"] = known_oi[key]
        r["prev_volume"] = last_session["volumes"].get(key)
        book["rows"][key] = r
    everything = list(book["rows"].values())
    # the page gets the contracts that traded (today or last session) plus the ones near the money
    rows = [r for r in everything if r["volume"] > 0 or r["prev_volume"] or (r["expiry"], r["strike"], r["right"]) in near]
    totals = {k: sum(r["volume"] for r in everything if r["right"] == k[0].upper()) for k in ("call", "put")}
    prem = {k: sum(r["premium"] for r in everything if r["right"] == k[0].upper()) for k in ("call", "put")}
    sw = _sweep.get(symbol, {})
    coverage = {"read": len(everything), "chain": sw.get("universe", len(everything)),
                "expiries": sw.get("expiries", 0), "expiries_known": sw.get("expiries_known", 0),
                "traded": sum(1 for r in everything if r["volume"] > 0)}

    iv_now = hist_iv[-1][1] if hist_iv else (iv_at(30, term) if term else None)
    last_year = [v for d, v in hist_iv if d >= (today - timedelta(days=365)).isoformat()]
    result = {
        "symbol": symbol, "as_of": stamp, "source": data_type, "seconds": round(clock.time() - started, 1),
        "spot": spot, "prev_close": quote["close"],
        "iv30": iv_now, "rv30": hist_rv[-1][1] if hist_rv else quote["hv"],
        "iv_rank": ((iv_now - min(last_year)) / (max(last_year) - min(last_year))
                    if iv_now is not None and len(last_year) > 20 and max(last_year) > min(last_year) else None),
        "iv_percentile": percentile(iv_now, last_year) if len(last_year) > 20 else None,
        "history": {"iv": hist_iv, "rv": hist_rv},
        "term": term, "atm": {str(d): iv_at(d, term) for d in SKEW_TENORS},
        "skew": {"buckets": BUCKETS, "tenors": skew}, "skew25": skew25, "forward_factor": ff,
        "flow": {"rows": rows, "expiries": sorted({r["expiry"] for r in rows}), "near_expiries": picks["flow"],
                 "since": (previous or {}).get("as_of"), "coverage": coverage,
                 "call_volume": totals["call"], "put_volume": totals["put"],
                 "call_premium": prem["call"], "put_premium": prem["put"], "prev_day": last_session["day"],
                 "underlying_call_volume": quote["call_volume"], "underlying_put_volume": quote["put_volume"]},
    }
    save(result, today)
    result.update(stored(symbol, today))
    return result


# ---------- storage ----------

def save(r: dict, today: date) -> None:
    with connect_db() as conn:
        a = r["atm"]
        conn.execute("INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     (r["symbol"], today.isoformat(), r["as_of"], r["spot"], a["30"], a["60"], a["90"], r["skew25"],
                      r["forward_factor"]["value"], json.dumps(r["term"]), json.dumps(r["skew"]["tenors"])))
        f = r["flow"]
        if f["rows"]:
            conn.execute("INSERT OR REPLACE INTO flow_points VALUES (?,?,?,?,?,?)",
                         (r["symbol"], r["as_of"], f["call_volume"], f["put_volume"], f["call_premium"], f["put_premium"]))
        conn.execute("INSERT INTO watchlist VALUES (?,?,?) ON CONFLICT(symbol) DO UPDATE SET last_viewed = excluded.last_viewed",
                     (r["symbol"], r["as_of"], r["as_of"]))


def stored(symbol: str, today: date) -> dict:
    """history only this app keeps: daily skew and forward factor, past term structures, today's flow points."""
    with connect_db() as conn:
        snaps = [dict(x) for x in conn.execute("SELECT * FROM snapshots WHERE symbol = ? ORDER BY date", (symbol,))]
        start = datetime.combine(today, datetime.min.time(), NY).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        points = [dict(x) for x in conn.execute("SELECT * FROM flow_points WHERE symbol = ? AND time >= ? ORDER BY time",
                                                 (symbol, start))]
    past = []
    for label, days in (("1 week ago", 7), ("1 month ago", 30), ("3 months ago", 91)):
        target = (today - timedelta(days=days)).isoformat()
        older = [s for s in snaps if s["date"] <= target]
        # only a snapshot within a few days of the target date stands for it
        if older and (date.fromisoformat(target) - date.fromisoformat(older[-1]["date"])).days <= 4:
            past.append({"label": label, "date": older[-1]["date"], "term": json.loads(older[-1]["term"])})
    return {
        "stored": {"days": len(snaps), "since": snaps[0]["date"] if snaps else None,
                   "skew25": [[s["date"], s["skew25"]] for s in snaps if s["skew25"] is not None],
                   "forward_factor": [[s["date"], s["ff"]] for s in snaps if s["ff"] is not None],
                   "atm30": [[s["date"], s["atm30"]] for s in snaps if s["atm30"] is not None]},
        "term_past": past,
        "flow_points": points,
    }


def cached_contracts(symbol: str, expiry: str) -> list | None:
    with connect_db() as conn:
        row = conn.execute("SELECT fetched, contracts FROM option_contracts WHERE symbol = ? AND expiry = ?",
                           (symbol, expiry)).fetchone()
    if row and (ny_today() - date.fromisoformat(row["fetched"])).days <= 2:
        return json.loads(row["contracts"])
    return None


def store_contracts(symbol: str, expiry: str, rows: list) -> None:
    with connect_db() as conn:
        conn.execute("INSERT OR REPLACE INTO option_contracts VALUES (?,?,?,?)",
                     (symbol, expiry, ny_today().isoformat(), json.dumps(rows)))


def remember_oi(symbol: str, rows: list[dict], today: date) -> dict:
    """store the open interest tws sent this time; return the last known figure (and its date) for every contract,
    from the past few days, for the ones it didn't send."""
    fresh = [(symbol, r["expiry"], r["strike"], r["right"], r["oi"], today.isoformat()) for r in rows if r["oi"] is not None]
    since = (today - timedelta(days=4)).isoformat()
    with connect_db() as conn:
        conn.executemany("INSERT OR REPLACE INTO option_oi VALUES (?,?,?,?,?,?)", fresh)
        return {(x["expiry"], x["strike"], x["right"]): (x["oi"], x["date"]) for x in conn.execute(
            "SELECT expiry, strike, right, oi, date FROM option_oi WHERE symbol = ? AND date >= ?", (symbol, since))}


def previous_session_volume(symbol: str, today: date) -> dict:
    """each contract's volume in the last session before today, from the stored 30-minute bars."""
    with connect_db() as conn:
        row = conn.execute("SELECT MAX(day) FROM option_bars WHERE symbol = ? AND day < ?", (symbol, today.isoformat())).fetchone()
        day = row[0] if row else None
        vols = {} if not day else {(x[0], x[1], x[2]): x[3] for x in conn.execute(
            "SELECT expiry, strike, right, SUM(volume) FROM option_bars WHERE symbol = ? AND day = ? GROUP BY expiry, strike, right",
            (symbol, day))}
    return {"day": day, "volumes": vols}


def session_flow(symbol: str, sessions: int = HISTORY_SESSIONS) -> dict:
    """call and put volume and premium per 30 minutes over the last sessions, with the share price, from stored bars."""
    with connect_db() as conn:
        days = [r[0] for r in conn.execute("SELECT DISTINCT day FROM underlying_bars WHERE symbol = ? ORDER BY day DESC LIMIT ?",
                                           (symbol, sessions))][::-1]
        if not days:
            return {"bars": [], "days": [], "contracts": 0}
        marks = ",".join("?" * len(days))
        price = {r[0]: r[1] for r in conn.execute(f"SELECT time, close FROM underlying_bars WHERE symbol = ? AND day IN ({marks})",
                                                    (symbol, *days))}
        flow = {r[0]: r for r in conn.execute(
            "SELECT time,"
            " SUM(CASE WHEN right = 'C' THEN volume ELSE 0 END), SUM(CASE WHEN right = 'P' THEN volume ELSE 0 END),"
            " SUM(CASE WHEN right = 'C' THEN volume * close * 100 ELSE 0 END), SUM(CASE WHEN right = 'P' THEN volume * close * 100 ELSE 0 END)"
            f" FROM option_bars WHERE symbol = ? AND day IN ({marks}) GROUP BY time", (symbol, *days))}
        contracts = conn.execute(f"SELECT COUNT(DISTINCT expiry || strike || right) FROM option_bars WHERE symbol = ? AND day IN ({marks})",
                                 (symbol, *days)).fetchone()[0]
        day_of = {r[0]: r[1] for r in conn.execute(f"SELECT time, day FROM underlying_bars WHERE symbol = ? AND day IN ({marks})",
                                                     (symbol, *days))}
    bars = []
    for t in sorted(price):
        f = flow.get(t)
        bars.append({"time": t, "day": day_of[t], "price": price[t], "call_volume": f[1] if f else 0, "put_volume": f[2] if f else 0,
                     "call_premium": f[3] if f else 0, "put_premium": f[4] if f else 0})
    summary = []
    for d in days:
        bs_ = [b for b in bars if b["day"] == d]
        summary.append({"day": d, "close": bs_[-1]["price"] if bs_ else None,
                        **{k: sum(b[k] for b in bs_) for k in ("call_volume", "put_volume", "call_premium", "put_premium")}})
    return {"bars": bars, "days": summary, "contracts": contracts}


def watchlist() -> list[dict]:
    with connect_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT w.symbol, w.last_viewed, (SELECT COUNT(*) FROM snapshots s WHERE s.symbol = w.symbol) AS days"
            " FROM watchlist w ORDER BY w.last_viewed DESC")]


# ---------- past sessions ----------

_history: dict[str, dict] = {}  # symbol -> {running, done, total, built_at, error}


def last_closed_session(now: datetime | None = None) -> str:
    """the latest new york session that has finished: today after 16:15, otherwise the weekday before."""
    now = now or datetime.now(NY)
    d = now.date()
    if not (d.weekday() < 5 and now.time() >= datetime.strptime("16:15", "%H:%M").time()):
        d -= timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.isoformat()


_fetched: dict[str, dict[tuple, str]] = {}  # symbol -> contract -> new york day its bars were last read


def history_pool(data: dict) -> list[tuple]:
    """contracts whose past sessions are worth reading: every one seen trading, today or last session, and the
    ones near the money; nearest the money first."""
    spot = data["spot"]
    rows = sorted(data["flow"]["rows"], key=lambda r: abs(r["strike"] / spot - 1))
    return [(r["expiry"], r["strike"], r["right"]) for r in rows]


def history_due(symbol: str, pool: list[tuple]) -> bool:
    """finished sessions don't change, so bars are read when a session is missing, or for contracts that have
    started trading since the last read."""
    st = _history.get(symbol)
    if st and (st["running"] or clock.time() - st["built_at"] < HISTORY_RETRY):
        return False
    with connect_db() as conn:
        last = conn.execute("SELECT MAX(day) FROM underlying_bars WHERE symbol = ?", (symbol,)).fetchone()[0]
    if last is None or last < last_closed_session():
        return True
    seen = _fetched.get(symbol, {})
    today = ny_today().isoformat()
    return any(seen.get(k) != today for k in pool)


async def build_history(symbol: str, keys: list[tuple]) -> None:
    """30-minute trade bars for the flow contracts and the share, over the last sessions, into vol.db.

    one request per contract on its own tws connection, so the minute-by-minute read carries on. tws answers these
    one at a time (about 1 to 2 s each; asking for several at once only makes them time out), so a first build of
    300 contracts takes about ten minutes. strikes nearest the money go first, and the page redraws as they land.
    later builds only read the last two sessions, once a day. contracts that have expired
    are gone from tws, but their bars stay in vol.db once stored."""
    from ib_async import IB, Option, Stock
    st = _history.setdefault(symbol, {"running": False, "done": 0, "total": 0, "built_at": 0.0, "error": None})
    if st["running"]:
        return
    if os.environ.get("VOL_SOURCE") == "sim":
        await simulated_history(symbol, keys, st)
        return
    st.update(running=True, done=0, total=len(keys), error=None)
    ib = IB()
    try:
        for cid in (HISTORY_CLIENT_ID, HISTORY_CLIENT_ID + 1):
            try:
                await ib.connectAsync("127.0.0.1", PORT, clientId=cid, readonly=True, timeout=6)
                break
            except Exception:
                ib.disconnect()
        if not ib.isConnected():
            raise VolError("TWS isn't reachable for the trade history.")
        with connect_db() as conn:
            last = conn.execute("SELECT MAX(day) FROM underlying_bars WHERE symbol = ?", (symbol,)).fetchone()[0]
            stored = {(x[0], x[1], x[2]) for x in conn.execute(
                "SELECT DISTINCT expiry, strike, right FROM option_bars WHERE symbol = ?", (symbol,))}
        recent = last and (ny_today() - date.fromisoformat(last)).days <= 3
        duration = "2 D" if recent else f"{HISTORY_SESSIONS} D"
        seen = _fetched.setdefault(symbol, {})
        today = ny_today().isoformat()
        missing_session = last is None or last < last_closed_session()
        # a session missing: every contract again; otherwise only the ones not read today
        keys = [k for k in keys if missing_session or seen.get(k) != today]
        st["total"] = len(keys)

        def rows_of(bars) -> list[tuple]:
            out = []
            for x in bars:
                t = x.date if isinstance(x.date, datetime) else datetime.combine(x.date, datetime.min.time(), timezone.utc)
                out.append((t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), t.astimezone(NY).date().isoformat(),
                            x.close, x.volume))
            return out

        und = (await ib.qualifyContractsAsync(Stock(symbol, "SMART", "USD")))[0]
        bars = await ib.reqHistoricalDataAsync(und, "", duration, "30 mins", "TRADES", True, 2, timeout=30)
        with connect_db() as conn:
            conn.executemany("INSERT OR REPLACE INTO underlying_bars VALUES (?,?,?,?)",
                             [(symbol, t, d, c) for t, d, c, _ in rows_of(bars)])
        ids = {}
        for e in {k[0] for k in keys}:
            for cid, k, r, tc, mult in cached_contracts(symbol, e) or []:
                ids[(e, float(k), r)] = (cid, tc, mult)
        for e, k, r in keys:
            found = ids.get((e, float(k), r))
            if found:
                c = Option(symbol, e, k, r, "SMART", found[2], "USD", tradingClass=found[1], conId=found[0])
                # a contract never read before gets all five sessions
                span = duration if (e, float(k), r) in stored else f"{HISTORY_SESSIONS} D"
                try:
                    bars = await ib.reqHistoricalDataAsync(c, "", span, "30 mins", "TRADES", True, 2, timeout=10)
                except Exception:
                    bars = []
                with connect_db() as conn:
                    conn.executemany("INSERT OR REPLACE INTO option_bars VALUES (?,?,?,?,?,?,?,?)",
                                     [(symbol, e, k, r, t, d, cl, v) for t, d, cl, v in rows_of(bars) if v and v > 0])
            seen[(e, k, r)] = today
            st["done"] += 1
        st["built_at"] = clock.time()
    except Exception as e:
        st["error"] = str(e)
        st["built_at"] = clock.time()  # don't retry straight away
    finally:
        st["running"] = False
        ib.disconnect()


async def simulated_history(symbol: str, keys: list[tuple], st: dict) -> None:
    """made-up 30-minute bars for the last sessions, so the page's history works without tws (VOL_SOURCE=sim)."""
    src = SimSource()
    await src.underlying(symbol)
    spot = (await src.spot(None))["spot"]
    rng = random.Random(f"{symbol}:sessions")
    days, d = [], ny_today() - timedelta(days=1)
    while len(days) < HISTORY_SESSIONS:
        if d.weekday() < 5:
            days.append(d)
        d -= timedelta(days=1)
    s, und_rows, opt_rows = spot * 0.95, [], []
    for day in reversed(days):
        for slot in range(13):  # 09:30 to 16:00 new york, every 30 minutes
            start = datetime.combine(day, datetime.min.time(), NY).replace(hour=9, minute=30) + timedelta(minutes=30 * slot)
            t = start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            s *= math.exp(rng.gauss(0.0004, 0.006))
            und_rows.append((symbol, t, day.isoformat(), round(s, 2)))
            busy = 1.6 if slot in (0, 1, 12) else 1.0  # opens and closes are busier
            for e, k, r in keys[:400]:
                days_left = max((datetime.strptime(e, "%Y%m%d").date() - day).days, 1)
                near = math.exp(-abs(math.log(k / s)) / 0.08)
                vol = int(rng.lognormvariate(0, 1.1) * 60 * near * busy * (1.3 if r == "C" else 1.0))
                if vol:
                    px = bs.price(r, s, k, days_left / 365, src._iv(k, s, days_left))
                    opt_rows.append((symbol, e, k, r, t, day.isoformat(), round(max(px, 0.01), 2), vol))
    with connect_db() as conn:
        conn.executemany("INSERT OR REPLACE INTO underlying_bars VALUES (?,?,?,?)", und_rows)
        conn.executemany("INSERT OR REPLACE INTO option_bars VALUES (?,?,?,?,?,?,?,?)", opt_rows)
    seen = _fetched.setdefault(symbol, {})
    for k in keys:
        seen[k] = ny_today().isoformat()
    st.update(done=len(keys), total=len(keys), built_at=clock.time(), error=None)


# ---------- api ----------

router = APIRouter(prefix="/api/vol")
_lock = asyncio.Lock()
_cache: dict[str, dict] = {}  # symbol -> {_t, data, error}
_active: dict[str, float] = {}  # symbol -> when the page last asked
_loop: asyncio.Task | None = None


async def _pull(symbol: str) -> None:
    async with _lock:
        hit = _cache.get(symbol)
        started = clock.time()  # the minute is counted from the start of a read, so reads begin a minute apart
        try:
            data = await collect(symbol, hit["data"] if hit and hit.get("data") else None)
            _cache[symbol] = {"_t": started, "data": data, "error": None}
        except VolError as e:
            _cache[symbol] = {**(hit or {"data": None}), "_t": started, "error": str(e), "status": e.status}


async def _refresher() -> None:
    """while a ticker's page is open, read it from tws again every minute, and its past sessions every half hour."""
    while True:
        now = clock.time()
        for sym, seen in list(_active.items()):
            if now - seen > ACTIVE_FOR:
                _active.pop(sym, None)
                continue
            hit = _cache.get(sym)
            if not hit or now - hit["_t"] >= LIVE_EVERY:
                try:
                    await _pull(sym)
                except Exception as e:  # never let one bad read stop the loop
                    _cache[sym] = {**(hit or {"data": None}), "_t": clock.time(), "error": str(e)}
            hit = _cache.get(sym)
            if hit and hit.get("data"):
                pool = history_pool(hit["data"])
                if history_due(sym, pool):
                    asyncio.create_task(build_history(sym, pool))
        await asyncio.sleep(3)


def _payload(symbol: str) -> dict:
    hit = _cache[symbol]
    data = dict(hit["data"])
    st = _history.get(symbol, {})
    data["sessions"] = {**session_flow(symbol), "building": bool(st.get("running")), "done": st.get("done", 0),
                        "total": st.get("total", 0), "error": st.get("error")}
    data["live"] = {"every": LIVE_EVERY, "error": hit.get("error"), "next_in": max(0, round(LIVE_EVERY - (clock.time() - hit["_t"])))}
    # the page polls this; a new version means new data to draw
    data["version"] = f"{data['as_of']}|{len(data['sessions']['bars'])}|{st.get('done', 0)}|{int(st.get('built_at', 0))}"
    return data


@router.get("")
def list_watchlist() -> dict:
    return {"watchlist": watchlist(), "source": "sim" if os.environ.get("VOL_SOURCE") == "sim" else "tws"}


@router.delete("/watchlist/{symbol}")
def remove(symbol: str) -> dict:
    with connect_db() as conn:
        conn.execute("DELETE FROM watchlist WHERE symbol = ?", (symbol.upper(),))
    return list_watchlist()


@router.get("/{symbol}")
async def get_vol(symbol: str, refresh: bool = False, live: bool = True) -> dict:
    """answers from memory at once when it can. live=true (the page's poll) keeps the ticker on the minute-by-minute
    read; refresh=true reads tws now."""
    global _loop
    key = symbol.upper().strip()
    if not key.replace(".", "").isalnum() or len(key) > 10:
        raise HTTPException(400, "That doesn't look like a ticker.")
    if live:
        _active[key] = clock.time()
        if _loop is None or _loop.done():
            _loop = asyncio.create_task(_refresher())
    hit = _cache.get(key)
    if refresh or not hit or not hit.get("data") or (not live and clock.time() - hit["_t"] > CACHE_SECONDS):
        await _pull(key)
        hit = _cache[key]
    if not hit.get("data"):
        raise HTTPException(hit.get("status", 503), hit.get("error") or "No data yet.")
    return _payload(key)


# ---------- command line ----------

async def _main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("symbol", nargs="?")
    ap.add_argument("--watchlist", action="store_true", help="snapshot every ticker on the watchlist")
    args = ap.parse_args()
    symbols = [w["symbol"] for w in watchlist()] if args.watchlist else [args.symbol]
    for s in filter(None, symbols):
        try:
            r = await collect(s)
        except VolError as e:
            print(f"{s}: {e}")
            continue
        ff = r["forward_factor"]["value"]
        print(f"{r['symbol']} spot {r['spot']:.2f} ({r['source']}, {r['seconds']}s): iv30 {r['iv30'] or 0:.1%}, "
              f"rv30 {r['rv30'] or 0:.1%}, 25d skew {r['skew25'] or 0:+.2f} pts, forward factor "
              f"{(ff or 0):+.1%}, {len(r['term'])} expiries, {len(r['flow']['rows'])} flow contracts")


if __name__ == "__main__":
    asyncio.run(_main())
