"""fills data/journal.db and data/signals.db with the demo account shown on opendesk.bid.

a $19,000 account from 02 jun to 04 nov 2026 with fourteen closed option trades. the six most recent are the
ones on the website; eight older ones fill in the summer. every price is black-scholes on real daily prices
(server/demo_data.json), so entries, exits, marks, greeks and mae/mfe hang together. the account curve and the
spy line are the website's. regime readings are made up but shaped like real ones, so the regime page has
something to read without a fred key. sector prices come from yahoo when the sectors page is opened.

thesis and post-mortem stay empty: those are written by the trader, never generated.

run:  python3 -m server.demo   (wipes and rebuilds both demo databases)
"""
import json
import random
from datetime import date, datetime, timedelta, timezone
from math import log, sqrt
from pathlib import Path
from zoneinfo import ZoneInfo

from . import bs
from .db import connect
from .signals import store

DATA = json.loads(Path(__file__).with_name("demo_data.json").read_text())
DAYS: list[str] = DATA["days"]
PX: dict[str, dict[str, list[float]]] = DATA["prices"]  # symbol -> date -> [low, high, close]
NY = ZoneInfo("America/New_York")
CAPITAL = 19_000.0
RATE = 0.038  # 13-week t-bill, period average
SOURCE = "demo"


def fee(contracts: int, sold: int = 0) -> float:
    """ibkr pro fixed: $0.65 a contract, $1.00 minimum per order, plus about $0.02 per contract sold."""
    return round(max(1.0, 0.65 * contracts) + 0.02 * sold, 2)


# one dict per trade. legs: (side, right, strike). opened and each close are (date, new york time).
# closes: (date, time, quantity, price per unit). iv: the main leg's implied vol for the daily marks;
# iv_after drops it from a date (skhy after earnings). dip / pop add one intraday mark at that p&l when the
# daily closes never got that far, so mae / mfe match the website's averages.
TRADES = [
    # summer: older trades, not on the website's table
    dict(sym="NVDA", strategy="Long put", legs=[("BUY", "P", 205)], expiry="2026-07-17", qty=2,
         opened=("2026-06-04", "10:12"), entry=5.12, iv=0.38, dip=-150,
         closes=[("2026-06-12", "11:40", 1, 9.23), ("2026-06-12", "14:05", 1, 9.23)]),
    dict(sym="QQQ", strategy="Long call", legs=[("BUY", "C", 725)], expiry="2026-07-17", qty=1,
         opened=("2026-06-23", "10:31"), entry=10.33, iv=0.20, pop=72,
         closes=[("2026-06-26", "15:18", 1, 7.25)]),
    dict(sym="PLTR", strategy="Long call", legs=[("BUY", "C", 115)], expiry="2026-08-21", qty=1,
         opened=("2026-06-24", "09:58"), entry=9.91, iv=0.56,
         closes=[("2026-07-06", "13:22", 1, 21.33)]),
    dict(sym="NVDA", strategy="Long put", legs=[("BUY", "P", 205)], expiry="2026-08-21", qty=1,
         opened=("2026-07-13", "11:05"), entry=10.40, iv=0.38,
         closes=[("2026-07-21", "14:47", 1, 7.82)]),
    dict(sym="PLTR", strategy="Long put", legs=[("BUY", "P", 120)], expiry="2026-08-21", qty=3,
         opened=("2026-07-20", "10:44"), entry=3.29, iv=0.58, dip=-88,
         closes=[("2026-07-28", "12:16", 3, 5.60)]),
    dict(sym="SPY", strategy="Long call", legs=[("BUY", "C", 750)], expiry="2026-08-21", qty=1,
         opened=("2026-07-31", "10:20"), entry=9.87, iv=0.15, dip=-140,
         closes=[("2026-08-10", "15:02", 1, 24.71)]),
    dict(sym="SKHY", strategy="Long call", legs=[("BUY", "C", 180)], expiry="2026-09-18", qty=1,
         opened=("2026-08-13", "09:52"), entry=10.00, iv=0.72,
         closes=[("2026-08-21", "13:39", 1, 7.02)]),
    dict(sym="SKHY", strategy="Long call", legs=[("BUY", "C", 170)], expiry="2026-09-18", qty=4,
         opened=("2026-08-24", "10:08"), entry=6.30, iv=0.72, dip=-90,
         closes=[("2026-08-28", "14:33", 4, 7.89)]),
    # the six on the website's recent trades table. marks use each day's low, high and close.
    dict(sym="AMD", strategy="Long call", legs=[("BUY", "C", 500)], expiry="2026-09-18", qty=1,
         opened=("2026-08-18", "09:47"), entry=15.30, iv=0.38, intraday=True,
         closes=[("2026-08-24", "15:21", 1, 7.60)]),
    dict(sym="SPY", strategy="Short put spread", legs=[("SELL", "P", 765), ("BUY", "P", 755)], expiry="2026-09-18",
         qty=2, opened=("2026-09-03", "09:41"), entry=-2.65, iv=0.15, intraday=True,
         closes=[("2026-09-10", "14:12", 2, -4.90)]),
    dict(sym="PLTR", strategy="Long call", legs=[("BUY", "C", 190)], expiry="2026-12-18", qty=2,
         opened=("2026-09-15", "09:44"), entry=13.10, iv=0.545, intraday=True,
         closes=[("2026-10-02", "13:55", 2, 18.70)]),
    dict(sym="NVDA", strategy="Long call", legs=[("BUY", "C", 230)], expiry="2026-10-16", qty=4,
         opened=("2026-09-24", "09:50"), entry=5.10, iv=0.325, intraday=True,
         closes=[("2026-10-06", "15:36", 4, 11.10)]),
    dict(sym="QQQ", strategy="Long call", legs=[("BUY", "C", 775)], expiry="2026-10-30", qty=3,
         opened=("2026-10-09", "09:43"), entry=7.90, iv=0.226, intraday=True,
         closes=[("2026-10-13", "10:07", 3, 3.45)]),
    dict(sym="SKHY", strategy="Long call", legs=[("BUY", "C", 150)], expiry="2026-11-20", qty=2,
         opened=("2026-10-22", "09:46"), entry=6.20, iv=0.769, iv_after=("2026-10-28", 0.52), intraday=True,
         closes=[("2026-10-27", "15:10", 1, 9.80), ("2026-10-28", "10:22", 1, 18.40)]),
]
BIAS = {"Long call": "bullish", "Long put": "bearish", "Short put spread": "bullish"}


def utc(d: str, hhmm: str) -> str:
    """new york wall time on a session date, as iso utc."""
    h, m = map(int, hhmm.split(":"))
    t = datetime(*map(int, d.split("-")), h, m, tzinfo=NY).astimezone(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def years(d: str, expiry: str) -> float:
    """time to expiry from the close of day d, in years. same convention the website's model used."""
    return max(0.0, (date.fromisoformat(expiry) - date.fromisoformat(d)).days / 365)


def iv_on(t: dict, d: str) -> float:
    after = t.get("iv_after")
    return after[1] if after and d >= after[0] else t["iv"]


def value(t: dict, d: str, s: float) -> float:
    """net value per unit of the whole position at underlying s on day d. negative for a credit spread."""
    sign = {"BUY": 1, "SELL": -1}
    return sum(sign[side] * bs.price(right, s, k, years(d, t["expiry"]), iv_on(t, d), RATE)
               for side, right, k in t["legs"])


def solve_underlying(t: dict, d: str, target: float) -> float:
    """the underlying price inside day d's range at which the position is worth target (bisection)."""
    lo, hi = PX[t["sym"]][d][0], PX[t["sym"]][d][1]
    f = lambda s: value(t, d, s) - target
    if f(lo) * f(hi) > 0:
        return lo if abs(f(lo)) < abs(f(hi)) else hi
    for _ in range(60):
        mid = (lo + hi) / 2
        if f(lo) * f(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return round((lo + hi) / 2, 2)


def leg_prices(t: dict, d: str, s: float, net: float) -> list[float]:
    """per-leg fill prices that add up to the position's net price."""
    sign = {"BUY": 1, "SELL": -1}
    raw = [bs.price(right, s, k, years(d, t["expiry"]), iv_on(t, d), RATE) for _, right, k in t["legs"]]
    if len(raw) == 1:
        return [abs(net)]
    # spread: keep the model's long leg, put the rest on the short leg
    out = [round(p, 2) for p in raw]
    i_short = next(i for i, (side, _, _) in enumerate(t["legs"]) if side == "SELL")
    i_long = 1 - i_short
    out[i_short] = round(out[i_long] - net, 2) if sign[t["legs"][i_long][0]] == 1 else out[i_short]
    return out


def position_greeks(t: dict, d: str, s: float) -> dict:
    agg = {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    for side, right, k in t["legs"]:
        g = bs.greeks(right, s, k, max(years(d, t["expiry"]), 1e-6), iv_on(t, d), RATE)
        for name in agg:
            agg[name] += (1 if side == "BUY" else -1) * g[name] * 100 * t["qty"]
    return agg


def hv20(sym: str, d: str) -> float | None:
    closes = [PX[sym][x][2] for x in sorted(PX[sym]) if x <= d]
    if len(closes) < 21:
        return None
    rets = [log(closes[i] / closes[i - 1]) for i in range(len(closes) - 20, len(closes))]
    m = sum(rets) / len(rets)
    return sqrt(sum((r - m) ** 2 for r in rets) / (len(rets) - 1)) * sqrt(252)


def contract_desc(t: dict, right: str, k: float) -> str:
    return f"{t['sym']} {date.fromisoformat(t['expiry']).strftime('%d%b%y').upper()} {k:g} {right}"


def build_trade(conn, t: dict, rng: random.Random) -> dict:
    sym, qty, entry = t["sym"], t["qty"], t["entry"]
    d_open, t_open = t["opened"]
    d_close = t["closes"][-1][0]
    n_legs = len(t["legs"])
    credit = entry < 0
    # fees per order: opening is one order; each close is its own order. sold contracts pay the regulatory fee.
    sold_open = qty if credit else 0
    open_fee = fee(qty * n_legs, sold_open)
    close_fees = [fee(n * n_legs, n) for _, _, n, _ in t["closes"]]
    fees = round(open_fee + sum(close_fees), 2)
    gross = round(sum(n * 100 * (p - entry) for _, _, n, p in t["closes"]), 2)
    net = round(gross - fees, 2)
    exit_px = round(sum(n * p for _, _, n, p in t["closes"]) / qty, 4)
    # 1r is the planned risk: a stop at half the debit, or at twice the credit on the spread
    one_r = round(abs(entry) * 100 * qty * (1.0 if credit else 0.5), 2)

    # p&l path, gross of fees like the website's model
    marks: list[tuple[str, float, float]] = []
    held = [d for d in DAYS if d_open <= d <= d_close and d in PX[sym]]
    for d in held:
        done = [(fd, n, p) for fd, _, n, p in t["closes"] if fd < d or (fd == d and fd != d_close)]
        left = qty - sum(n for _, n, _ in done)
        realized = sum(n * 100 * (p - entry) for _, n, p in done)
        pnl = lambda s: realized + left * 100 * (value(t, d, s) - entry)
        lo, hi, cl = PX[sym][d]
        if d == d_close:
            marks.append((utc(d, t["closes"][-1][1]), solve_underlying(t, d, t["closes"][-1][3]), gross))
            continue
        if t.get("intraday"):
            prev = PX[sym].get(DAYS[DAYS.index(d) - 1], [0, 0, cl])[2] if DAYS.index(d) else cl
            order = [(lo, "11:00"), (hi, "13:30")] if cl >= prev else [(hi, "11:00"), (lo, "13:30")]
            marks += [(utc(d, hm), s, round(pnl(s), 2)) for s, hm in order]
        marks.append((utc(d, "16:00"), cl, round(pnl(cl), 2)))
    # one extra intraday mark where the website's mae / mfe go past what the daily closes show
    for key, at in (("dip", 0), ("pop", 0)):
        if key in t:
            d = held[min(1, len(held) - 2)]
            lo, hi, _ = PX[sym][d]
            s = lo if (key == "dip") == (value(t, d, hi) > value(t, d, lo)) else hi
            marks.append((utc(d, "12:15"), s, float(t[key])))
    marks.sort()
    pnls = [m[2] for m in marks]
    mae, mfe = round(min(0.0, *pnls), 2), round(max(0.0, *pnls), 2)

    und_entry = solve_underlying(t, d_open, entry)
    und_exit = solve_underlying(t, d_close, t["closes"][-1][3])
    unds = [und_entry] + [m[1] for m in marks]
    pos = [entry] + [entry + m[2] / (100 * qty) for m in marks]
    g0, g1 = position_greeks(t, d_open, und_entry), position_greeks(t, d_close, und_exit)
    h = hv20(sym, d_open)
    row = {
        "underlying": sym, "strategy": t["strategy"], "bias": BIAS[t["strategy"]], "status": "closed",
        "quantity": qty, "opened_at": utc(d_open, t_open), "closed_at": utc(d_close, t["closes"][-1][1]),
        "entry_price": entry, "exit_price": exit_px, "max_risk": one_r, "realized_pnl": net, "commissions": fees,
        "mae": mae, "mfe": mfe, "und_entry": und_entry, "und_exit": und_exit,
        "und_high": round(max(unds), 2), "und_low": round(min(unds), 2),
        "pos_high": round(max(pos), 2), "pos_low": round(min(pos), 2),
        "iv_entry": t["iv"], "iv_exit": iv_on(t, d_close), "und_last": und_exit, "iv_last": iv_on(t, d_close),
        "last_update": utc(d_close, t["closes"][-1][1]),
        "iv_rank_entry": round(rng.uniform(22, 78), 1), "hv20_entry": None if h is None else round(h, 4),
        "dte_entry": (date.fromisoformat(t["expiry"]) - date.fromisoformat(d_open)).days,
        **{f"{k}_entry": round(v, 3 if k == "gamma" else 2) for k, v in g0.items()},
        **{f"{k}_exit": round(v, 3 if k == "gamma" else 2) for k, v in g1.items()},
        "source": SOURCE, "asset": "OPT", "multiplier": 100,
    }
    cur = conn.execute(f"INSERT INTO trades ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", list(row.values()))
    tid = cur.lastrowid

    in_px = leg_prices(t, d_open, und_entry, entry)
    out_px = leg_prices(t, d_close, und_exit, t["closes"][-1][3])
    for (side, right, k), p_in, p_out in zip(t["legs"], in_px, out_px):
        iv = iv_on(t, d_open)
        d_in = bs.greeks(right, und_entry, k, max(years(d_open, t["expiry"]), 1e-6), iv, RATE)["delta"]
        d_out = bs.greeks(right, und_exit, k, max(years(d_close, t["expiry"]), 1e-6), iv_on(t, d_close), RATE)["delta"]
        conn.execute("INSERT INTO legs (trade_id, side, ratio, right_, strike, expiry, entry_price, exit_price, iv_entry,"
                     " iv_exit, delta_entry, delta_exit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     (tid, side, 1, right, k, t["expiry"], p_in, p_out, iv, iv_on(t, d_close), round(d_in, 3),
                      round(d_out, 3)))

    # fills: one per leg per order. the order's commission is split across its legs; sold legs carry their fee.
    n = 0
    ib_rows = []

    def add_fill(when: str, action: str, side: str, right: str, k: float, q: int, price: float, comm: float):
        nonlocal n
        n += 1
        desc = contract_desc(t, right, k)
        conn.execute("INSERT INTO fills (trade_id, exec_id, time, action, side, description, quantity, price, commission)"
                     " VALUES (?,?,?,?,?,?,?,?,?)", (tid, f"demo.{tid:02d}.{n:02d}", when, action,
                                                      "BOT" if side == "BUY" else "SLD", desc, q, price, comm))
        ib_rows.append((f"demo-{tid:02d}-{n:02d}", f"demo.{tid:02d}.{n:02d}", when, when[:10], desc, sym, "OPT", right, k,
                        t["expiry"], side, "O" if action == "OPEN" else "C", q if side == "BUY" else -q, price, -comm,
                        round((-1 if side == "BUY" else 1) * q * price * 100 - comm, 2), None, None, 100))

    def split(total: float, legs: list[tuple[str, int]]) -> list[float]:
        """order commission per leg: the base shared evenly, the $0.02 per sold contract on the sold leg."""
        base = round(total - sum(0.02 * q for side, q in legs if side == "SELL"), 2)
        out = [round(base / len(legs) + (0.02 * q if side == "SELL" else 0), 2) for side, q in legs]
        out[-1] = round(total - sum(out[:-1]), 2)
        return out

    when = utc(d_open, t_open)
    comms = split(open_fee, [(side, qty) for side, _, _ in t["legs"]])
    for (side, right, k), p, c in zip(t["legs"], in_px, comms):
        add_fill(when, "OPEN", side, right, k, qty, round(p, 2), c)
    for (d, hm, q, _), cf in zip(t["closes"], close_fees):
        flip = {"BUY": "SELL", "SELL": "BUY"}
        comms = split(cf, [(flip[side], q) for side, _, _ in t["legs"]])
        for (side, right, k), p, c in zip(t["legs"], out_px, comms):
            add_fill(utc(d, hm), "CLOSE", flip[side], right, k, q, round(p, 2), c)
    conn.executemany("INSERT INTO ib_trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ib_rows)

    conn.executemany("INSERT INTO marks (trade_id, time, underlying, pnl) VALUES (?,?,?,?)",
                     [(tid, *m) for m in marks])
    # session closes for the theta chart (single-leg trades only), while the position was held overnight
    if n_legs == 1:
        conn.executemany("INSERT INTO option_daily VALUES (?,?,?,?)",
                         [(tid, d, PX[sym][d][2], round(value(t, d, PX[sym][d][2]), 2)) for d in held if d != d_close])
    return {"id": tid, "net": net, "r": net / one_r, "close_day": d_close, "mae": mae, "mfe": mfe}


def build_journal() -> list[dict]:
    rng = random.Random(404)
    conn = connect()
    for table in ("marks", "fills", "legs", "option_daily", "trades", "account_daily", "benchmark_daily", "ib_trades",
                  "cash_transactions", "sync_runs", "settings"):
        conn.execute(f"DELETE FROM {table}")
    built = [build_trade(conn, t, rng) for t in TRADES]

    # the website's account curve: cash plus realized plus open marks at each close, net of fees as paid
    realized_by_day: dict[str, float] = {}
    for b in built:
        realized_by_day[b["close_day"]] = realized_by_day.get(b["close_day"], 0.0) + b["net"]
    cum = 0.0
    for d, nlv in zip(DAYS, DATA["account"]):
        day_real = realized_by_day.get(d, 0.0)
        cum += day_real
        conn.execute("INSERT INTO account_daily VALUES (?,?,?,?)",
                     (d, nlv, round(day_real, 2), round(nlv - CAPITAL - cum, 2)))
    # spy with dividends reinvested, scaled to the first close, so the comparison is a total return
    base = PX["SPY"][DAYS[0]][2]
    conn.executemany("INSERT INTO benchmark_daily VALUES ('SPY', ?, ?)",
                     [(d, round(base * (1 + r / 100), 2)) for d, r in zip(DAYS, DATA["spy_total_return"])])
    # "as of" in the top bar: the last sync of the demo day, 04 nov 15:45 new york
    conn.execute("UPDATE trades SET last_update = ? WHERE id = ?", (utc(DAYS[-1], "15:45"), built[-1]["id"]))
    conn.execute("INSERT INTO sync_runs VALUES ('demo', ?, 'demo data from server/demo.py')", (utc(DAYS[-1], "15:45"),))
    conn.commit()
    conn.close()
    return built


def _walk(rng: random.Random, n: int, start: float, end: float, vol: float, shocks: dict[int, float] | None = None):
    """a random walk from start to end over n steps, pulled onto the end point (a brownian bridge)."""
    xs, x = [], start
    for i in range(n):
        x += rng.gauss(0, vol) + (shocks or {}).get(i, 0.0)
        xs.append(x)
    drift = [(end - xs[-1]) * (i + 1) / n for i in range(n)]
    return [a + b for a, b in zip(xs, drift)]


def _revert(rng: random.Random, n: int, speed: float, vol: float, shocks: dict[int, float]) -> list[float]:
    """noise that pulls back to zero, with one-off jumps that fade: added on top of a slow trend line."""
    xs, x = [], 0.0
    for i in range(n):
        x += -speed * x + rng.gauss(0, vol) + shocks.get(i, 0.0)
        xs.append(x)
    return xs


def _trend(n: int, start: float, end: float) -> list[float]:
    return [start + (end - start) * i / (n - 1) for i in range(n)]


def build_regime() -> None:
    """made-up regime series from jan 2024 to the demo day, ending in a growth reading: curve positive and steepening,
    spreads tight, vix calm, ism above 50 and rising, liquidity supportive."""
    rng = random.Random(7)
    d, end = date(2024, 1, 2), date.fromisoformat(DAYS[-1])
    sessions = []
    while d <= end:
        if d.weekday() < 5:
            sessions.append(d.isoformat())
        d += timedelta(days=1)
    n = len(sessions)
    hit = int(n * 0.43)  # a spring 2025 sell-off that fades over the following weeks
    y3m = _walk(rng, n, 5.38, 3.68, 0.018)
    y2 = _walk(rng, n, 4.33, 3.52, 0.035)
    y10 = _walk(rng, n, 3.95, 4.18, 0.04)
    hy = [max(2.5, a + b) for a, b in zip(_trend(n, 3.70, 2.90), _revert(rng, n, 0.03, 0.035, {hit: 1.1, hit + 1: 0.5}))]
    ig = [max(0.7, a + b) for a, b in zip(_trend(n, 1.04, 0.80), _revert(rng, n, 0.03, 0.008, {hit: 0.2, hit + 1: 0.1}))]
    vix = [max(10.5, a + b) for a, b in zip(_trend(n, 13.5, 15.2), _revert(rng, n, 0.08, 0.9, {hit: 16, hit + 1: 9}))]
    rows = []
    for i, s in enumerate(sessions):
        a, b, c = round(y3m[i], 2), round(y2[i], 2), round(y10[i], 2)
        rows += [("DGS3MO", s, a), ("DGS2", s, b), ("DGS10", s, c), ("T10Y3M", s, round(c - a, 2)),
                 ("T10Y2Y", s, round(c - b, 2)), ("BAMLH0A0HYM2", s, round(hy[i], 2)),
                 ("BAMLC0A0CM", s, round(ig[i], 2)), ("VIX", s, round(vix[i], 2))]
    # weekly, wednesdays, in millions of dollars: the fed's treasuries (qt, then flat) and the treasury's cash
    weeks = [x for x in sessions if date.fromisoformat(x).weekday() == 2]
    w = len(weeks)
    treast = _walk(rng, w, 4_780_000, 4_212_000, 3_000)
    tga = _walk(rng, w, 760_000, 812_000, 28_000)
    for i in range(w - 6, w):  # last six weeks: holdings growing, cash drawn down
        treast[i] = treast[w - 7] + (i - w + 7) * 4_500
        tga[i] = tga[w - 7] - (i - w + 7) * 9_000
    rows += [("TREAST", s, round(v)) for s, v in zip(weeks, treast)]
    rows += [("WTREGEN", s, round(v)) for s, v in zip(weeks, tga)]
    # monthly ism, dated the first of the month covered; last reading is october 2026
    months = [f"{y}-{m:02d}-01" for y in (2024, 2025, 2026) for m in range(1, 13) if f"{y}-{m:02d}" <= "2026-10"]
    k = len(months)
    mfg = _walk(rng, k, 49.1, 51.4, 0.7)
    svc = _walk(rng, k, 50.6, 53.6, 0.8)
    mfg[-2], svc[-2] = 50.6, 52.9
    rows += [("ISM_MFG", s, round(v, 1)) for s, v in zip(months, mfg)]
    rows += [("ISM_SVC", s, round(v, 1)) for s, v in zip(months, svc)]

    with store.connect() as conn:
        for table in ("regime_obs", "regime_state", "runs"):
            conn.execute(f"DELETE FROM {table}")
        conn.executemany("INSERT INTO regime_obs VALUES (?,?,?,?,?)",
                         [(sid, d, v, f"{d}T21:00:00Z", f"{d}T21:00:00Z") for sid, d, v in rows])
        stamp = utc(DAYS[-1], "15:45")
        conn.execute("INSERT INTO runs (source, started_at, finished_at, ok, rows, message) VALUES (?,?,?,?,?,?)",
                     ("regime", stamp, stamp, 1, len(rows), "demo data from server/demo.py"))


def main() -> None:
    built = build_journal()
    build_regime()
    net = sum(b["net"] for b in built)
    print(f"demo journal: {len(built)} closed trades, net {net:+,.2f}, account {DATA['account'][-1]:,.2f}"
          f" on {DAYS[-1]}; regime series written to data/signals.db")


if __name__ == "__main__":
    main()
