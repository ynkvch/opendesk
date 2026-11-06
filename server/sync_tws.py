"""Sync the journal database with your IBKR account through TWS (read-only).

What it does on each run:
  - account value for today            -> account_daily
  - SPY daily closes for the last year -> benchmark_daily
  - today's executions and commissions -> fills / trades (single-leg options)
  - for every open trade: hourly price path since entry, live mark and IV
    -> marks, MAE/MFE, underlying high/low, und_last / iv_last
  - for a trade that closed since the last run: the path up to the exit and the exit IV/Greeks

The TWS API only returns fills from the current day. Older fills (from the TWS Trade Log)
are added once with --add-fill; the contract comes from your open position.

Run (from dashboard/):
    python3 -m server.sync_tws
    python3 -m server.sync_tws --add-fill WULF --price 0.38 --qty 3 --commission 2.07 \
        --time "2026-10-02T14:35:17+01:00"
"""
import argparse
import sys
from datetime import date, datetime, time, timedelta, timezone
from math import log, sqrt
from zoneinfo import ZoneInfo

from ib_async import IB, ExecutionFilter, Option, Stock

from . import bs
from .db import connect as db_connect, journal_start
from .fills import add_to_trade, reduce_trade, refresh_realized

PORT = 7496
NY = timezone(timedelta(hours=-4))  # EDT; good enough for session dates until November
NY_TZ = ZoneInfo("America/New_York")


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def expiry_dt(c) -> datetime:
    return datetime.strptime(c.lastTradeDateOrContractMonth[:8], "%Y%m%d").replace(hour=20, tzinfo=timezone.utc)


def options_open() -> bool:
    """US options regular session, 9:30-16:00 New York, weekdays (exchange holidays not checked)."""
    now = datetime.now(NY_TZ)
    return now.weekday() < 5 and time(9, 30) <= now.time() < time(16)


def years_to(c, when: datetime) -> float:
    return max((expiry_dt(c) - when).total_seconds() / (365 * 86400), 1e-6)


def bars(ib: IB, contract, duration: str, size: str, what: str, rth: bool = True, end: str = ""):
    return ib.reqHistoricalData(contract, end, duration, size, what, rth, 2)


def price_at(ib: IB, contract, when: datetime, what: str = "TRADES") -> float | None:
    """Close of the 1-minute bar covering `when`."""
    end = (when + timedelta(minutes=2)).strftime("%Y%m%d %H:%M:%S UTC")
    b = bars(ib, contract, "1800 S", "1 min", what, False, end)
    before = [x for x in b if x.date <= when]
    return before[-1].close if before else (b[0].close if b else None)


# ---------------------------------------------------------------- account & benchmark

def sync_account(ib: IB, conn) -> None:
    vals = {v.tag: float(v.value) for v in ib.accountSummary() if v.currency in ("USD", "BASE") and
            v.tag in ("NetLiquidation", "RealizedPnL", "UnrealizedPnL")}
    today = datetime.now(NY).date().isoformat()
    conn.execute("INSERT OR REPLACE INTO account_daily VALUES (?,?,?,?)",
                 (today, vals.get("NetLiquidation", 0.0), vals.get("RealizedPnL", 0.0), vals.get("UnrealizedPnL", 0.0)))
    print(f"Account: net liquidation ${vals.get('NetLiquidation', 0):,.2f} on {today}")


def sync_benchmark(ib: IB, conn) -> None:
    spy = Stock("SPY", "SMART", "USD")
    ib.qualifyContracts(spy)
    b = bars(ib, spy, "1 Y", "1 day", "TRADES")
    start = journal_start(conn)[:10]
    conn.executemany("INSERT OR REPLACE INTO benchmark_daily VALUES ('SPY', ?, ?)",
                     [(x.date.isoformat(), x.close) for x in b if x.date.isoformat() >= start])
    print(f"SPY: {len(b)} daily closes")


# ---------------------------------------------------------------- trades and fills

def entry_context(ib: IB, c, when: datetime) -> dict:
    """Underlying price, IV, Greeks, IV rank and HV20 at the moment of entry."""
    und = Stock(c.symbol, "SMART", "USD")
    ib.qualifyContracts(und)
    spot = price_at(ib, und, when)
    daily = bars(ib, und, "3 M", "1 day", "TRADES")
    closes = [x.close for x in daily if x.date < when.astimezone(NY).date()]
    hv20 = None
    if len(closes) >= 21:
        r = [log(closes[i] / closes[i - 1]) for i in range(len(closes) - 20, len(closes))]
        m = sum(r) / len(r)
        hv20 = sqrt(sum((x - m) ** 2 for x in r) / (len(r) - 1)) * sqrt(252)
    ivs = bars(ib, und, "1 Y", "1 day", "OPTION_IMPLIED_VOLATILITY")
    upto = [x for x in ivs if x.date <= when.astimezone(NY).date()]
    iv_rank = None
    if upto:
        lo, hi = min(x.low for x in upto), max(x.high for x in upto)
        iv_rank = 100 * (upto[-1].open - lo) / (hi - lo) if hi > lo else None
    return {"spot": spot, "hv20": hv20, "iv_rank": iv_rank}


def open_trade(ib: IB, conn, c, when: datetime, price: float, qty: float, commission: float, exec_id: str) -> int:
    ctx = entry_context(ib, c, when)
    t = years_to(c, when)
    iv = bs.implied_vol(c.right, price, ctx["spot"], c.strike, t) if ctx["spot"] else None
    g = bs.greeks(c.right, ctx["spot"], c.strike, t, iv) if iv else {}
    mult = 100 * qty
    side = "Long"
    strategy = f"{side} {'call' if c.right == 'C' else 'put'}"
    cur = conn.execute(
        "INSERT INTO trades (underlying, strategy, bias, status, quantity, opened_at, entry_price, max_risk, commissions,"
        " und_entry, und_high, und_low, pos_high, pos_low, iv_entry, iv_rank_entry, hv20_entry, dte_entry,"
        " delta_entry, gamma_entry, theta_entry, vega_entry, source)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (c.symbol, strategy, "bullish" if c.right == "C" else "bearish", "open", qty, iso(when), price,
         round(price * mult, 2), commission, ctx["spot"], ctx["spot"], ctx["spot"], price, price, iv or 0,
         ctx["iv_rank"], ctx["hv20"], (expiry_dt(c).date() - when.astimezone(NY).date()).days,
         g.get("delta", 0) * mult, g.get("gamma", 0) * mult, g.get("theta", 0) * mult, g.get("vega", 0) * mult, "tws"))
    tid = cur.lastrowid
    expiry = expiry_dt(c).date().isoformat()
    conn.execute("INSERT INTO legs (trade_id, side, right_, strike, expiry, entry_price, iv_entry, delta_entry, conid)"
                 " VALUES (?,?,?,?,?,?,?,?,?)", (tid, "BUY", c.right, c.strike, expiry, price, iv or 0, g.get("delta", 0), c.conId))
    desc = f"{c.symbol} {expiry_dt(c):%d%b%y}".upper() + f" {c.strike:g} {c.right}"
    conn.execute("INSERT INTO fills (trade_id, exec_id, time, action, side, description, quantity, price, commission)"
                 " VALUES (?,?,?,?,?,?,?,?,?)", (tid, exec_id, iso(when), "OPEN", "BOT", desc, qty, price, commission))
    print(f"Opened trade {tid}: {desc} x{qty:g} @ {price}  IV {iv and iv * 100:.1f}%  delta {g.get('delta', 0):.3f}")
    return tid


def trade_for_conid(conn, conid: int, status: str = "open"):
    return conn.execute("SELECT t.id FROM trades t JOIN legs l ON l.trade_id = t.id WHERE l.conid = ? AND t.status = ?",
                        (conid, status)).fetchone()


def sync_executions(ib: IB, conn) -> None:
    fills = ib.reqExecutions(ExecutionFilter(secType="OPT"))
    new = 0
    for f in sorted(fills, key=lambda f: f.execution.time):
        e, c = f.execution, f.contract
        cr = f.commissionReport
        fee = cr.commission if cr and cr.commission < 1e9 else 0.0
        seen = conn.execute("SELECT id, trade_id, commission FROM fills WHERE exec_id = ?", (e.execId,)).fetchone()
        if seen:
            # the commission report can arrive after the fill was first recorded with none
            if not seen["commission"] and fee:
                conn.execute("UPDATE fills SET commission=? WHERE id=?", (fee, seen["id"]))
                conn.execute("UPDATE trades SET commissions=commissions+? WHERE id=?", (fee, seen["trade_id"]))
                refresh_realized(conn, seen["trade_id"])
                print(f"Commission {fee:.2f} added to fill {e.execId} (trade {seen['trade_id']})")
            continue
        ib.qualifyContracts(c)
        when = e.time.astimezone(timezone.utc)
        existing = trade_for_conid(conn, c.conId)
        desc = f"{c.symbol} {expiry_dt(c):%d%b%y}".upper() + f" {c.strike:g} {c.right}"
        if e.side == "BOT" and not existing:
            open_trade(ib, conn, c, when, e.price, e.shares, fee, e.execId)
        elif e.side == "BOT":
            add_to_trade(conn, existing["id"], iso(when), e.price, e.shares, fee, e.execId, desc)
            print(f"Added {e.shares:g} to trade {existing['id']} @ {e.price}")
        elif e.side == "SLD" and existing:
            done = reduce_trade(conn, existing["id"], iso(when), e.price, e.shares, fee, e.execId, desc)
            print(f"{'Closed' if done else 'Reduced'} trade {existing['id']}: sold {e.shares:g} @ {e.price}")
        else:
            print(f"Skipped fill {e.execId} ({c.localSymbol} {e.side}): opens a short position; not handled yet")
            continue
        new += 1
    print(f"Executions: {len(fills)} returned today, {new} new")


def enrich_entry(ib: IB, conn, t, c) -> None:
    """Trades imported from Flex arrive without entry IV/Greeks; fill them in from IBKR price history."""
    when = datetime.fromisoformat(t["opened_at"].replace("Z", "+00:00"))
    ctx = entry_context(ib, c, when)
    if not ctx["spot"]:
        return
    tyears = years_to(c, when)
    iv = bs.implied_vol(c.right, t["entry_price"], ctx["spot"], c.strike, tyears)
    g = bs.greeks(c.right, ctx["spot"], c.strike, tyears, iv) if iv else {}
    mult = 100 * t["quantity"]
    conn.execute("UPDATE trades SET und_entry=?, und_high=MAX(und_high, ?), und_low=CASE WHEN und_low=0 THEN ? ELSE "
                 "MIN(und_low, ?) END, iv_entry=?, iv_rank_entry=?, hv20_entry=?, delta_entry=?, gamma_entry=?, "
                 "theta_entry=?, vega_entry=? WHERE id=?",
                 (ctx["spot"], ctx["spot"], ctx["spot"], ctx["spot"], iv or 0, ctx["iv_rank"], ctx["hv20"],
                  g.get("delta", 0) * mult, g.get("gamma", 0) * mult, g.get("theta", 0) * mult, g.get("vega", 0) * mult,
                  t["id"]))
    conn.execute("UPDATE legs SET iv_entry=?, delta_entry=? WHERE trade_id=?", (iv or 0, g.get("delta", 0), t["id"]))
    print(f"Entry context added to trade {t['id']}: IV {iv and iv * 100:.1f}%, delta {g.get('delta', 0):.3f}")


# ---------------------------------------------------------------- open positions

def sync_open(ib: IB, conn) -> None:
    """Open trades, plus trades the sync tracked while open that closed since its last run: their path is
    finished up to the exit and the exit context (underlying, IV, Greeks) is filled in."""
    portfolio = {p.contract.conId: p for p in ib.portfolio()}
    rows = conn.execute(
        "SELECT * FROM trades WHERE status = 'open' OR (status = 'closed' AND asset = 'OPT'"
        " AND closed_at > COALESCE(last_update, '') AND EXISTS (SELECT 1 FROM option_daily o WHERE o.trade_id = trades.id))"
    ).fetchall()
    for t in rows:
        if t["status"] == "open":
            sync_trade(ib, conn, t, portfolio)
            continue
        try:
            sync_trade(ib, conn, t, portfolio)
        except Exception as ex:  # e.g. an expired contract IBKR no longer serves history for
            print(f"Closed trade {t['id']}: path not finished ({ex})")


def sync_trade(ib: IB, conn, t, portfolio: dict) -> None:
    closed = t["status"] == "closed"
    leg = conn.execute("SELECT * FROM legs WHERE trade_id = ?", (t["id"],)).fetchone()
    c = Option(conId=leg["conid"], exchange="SMART")
    ib.qualifyContracts(c)
    und = Stock(c.symbol, "SMART", "USD")
    ib.qualifyContracts(und)
    if not t["iv_entry"] or not t["und_entry"]:
        enrich_entry(ib, conn, t, c)
        t = conn.execute("SELECT * FROM trades WHERE id = ?", (t["id"],)).fetchone()
    opened = datetime.fromisoformat(t["opened_at"].replace("Z", "+00:00"))
    exited = datetime.fromisoformat(t["closed_at"].replace("Z", "+00:00")) if closed else None
    days = max(2, (datetime.now(timezone.utc) - opened).days + 2)
    ob = bars(ib, c, f"{days} D", "1 hour", "MIDPOINT")
    ub = {x.date: x for x in bars(ib, und, f"{days} D", "1 hour", "TRADES")}
    qty, mult = t["quantity"], 100 * t["quantity"]
    # session closes for the theta chart: the last hourly bar of each New York day wins
    # (a closed trade's exit day is not a full session held, so it stops the day before)
    closes = {}
    for x in ob:
        if exited and x.date.astimezone(NY_TZ).date() >= exited.astimezone(NY_TZ).date():
            continue
        if x.date in ub and x.date >= opened.replace(minute=0, second=0):
            closes[x.date.astimezone(NY_TZ).date().isoformat()] = (ub[x.date].close, x.close)
    conn.executemany("INSERT OR REPLACE INTO option_daily VALUES (?,?,?,?)",
                     [(t["id"], d, u, o) for d, (u, o) in closes.items()])
    marks = []
    for i, x in enumerate(ob):
        # a bar's close is at the next bar's start (the first RTH bar is only 30 minutes)
        end = ob[i + 1].date if i + 1 < len(ob) and ob[i + 1].date.date() == x.date.date() \
            else min(x.date + timedelta(hours=1), x.date.replace(hour=20, minute=0))
        if end <= opened or x.date not in ub or (exited and end > exited):
            continue
        u = ub[x.date]
        # closes, not intra-bar extremes: option midpoint highs/lows spike when spreads widen
        marks.append((iso(end), u.close, round((x.close - t["entry_price"]) * mult - t["commissions"], 2),
                      x.close, x.close, u.high, u.low))
    p = None
    if closed:
        # the exit itself is the last point of the path
        spot = price_at(ib, und, exited) or (marks[-1][1] if marks else t["und_entry"])
        marks.append((t["closed_at"], spot, t["realized_pnl"], t["exit_price"], t["exit_price"], spot, spot))
    else:
        # latest mark: IBKR's own portfolio valuation, only while options trade; outside the session
        # TWS prices the option with a model off the pre/post-market underlying instead of real quotes
        p = portfolio.get(c.conId) if options_open() else None
        if not options_open() and c.conId in portfolio:
            model_snapshot(ib, conn, t["id"], portfolio[c.conId], und)
        if p:
            now = datetime.now(timezone.utc)
            last_und = ub[max(ub)].close if ub else t["und_entry"]
            pnl = round(p.marketPrice * mult - p.averageCost * qty, 2)
            marks.append((iso(now), last_und, pnl, p.marketPrice, p.marketPrice, last_und, last_und))
    if not marks:
        return
    conn.execute("DELETE FROM marks WHERE trade_id = ?", (t["id"],))
    conn.executemany("INSERT OR REPLACE INTO marks (trade_id, time, underlying, pnl) VALUES (?,?,?,?)",
                     [(t["id"], m[0], m[1], m[2]) for m in marks])
    pnls = [m[2] for m in marks]
    last_px = t["exit_price"] if closed else (p.marketPrice if p else ob[-1].close)
    last_und = marks[-1][1]
    at = exited or datetime.now(timezone.utc)
    iv_last = bs.implied_vol(c.right, last_px, last_und, c.strike, years_to(c, at))
    conn.execute(
        "UPDATE trades SET mae=?, mfe=?, und_high=?, und_low=?, pos_high=?, pos_low=?, und_last=?, iv_last=?,"
        " last_update=? WHERE id=?",
        (min(0.0, min(pnls)), max(0.0, max(pnls)), max([t["und_entry"]] + [m[5] for m in marks]),
         min([t["und_entry"]] + [m[6] for m in marks]), max([t["entry_price"]] + [m[3] for m in marks]),
         min([t["entry_price"]] + [m[4] for m in marks]), last_und, iv_last, marks[-1][0], t["id"]))
    if closed:
        g = bs.greeks(c.right, last_und, c.strike, years_to(c, at), iv_last) if iv_last else {}
        conn.execute("UPDATE trades SET und_exit=?, iv_exit=?, delta_exit=?, gamma_exit=?, theta_exit=?, vega_exit=?"
                     " WHERE id=?", (last_und, iv_last, g.get("delta", 0) * mult, g.get("gamma", 0) * mult,
                                     g.get("theta", 0) * mult, g.get("vega", 0) * mult, t["id"]))
        conn.execute("UPDATE legs SET iv_exit=?, delta_exit=? WHERE trade_id=?", (iv_last, g.get("delta"), t["id"]))
    print(f"{'Closed' if closed else 'Open'} trade {t['id']} {c.localSymbol.strip()}: "
          f"{'exit' if closed else 'mark'} {last_px:.4f}, P&L {pnls[-1]:+.2f}, "
          f"MAE {min(0, min(pnls)):+.2f}, MFE {max(0, max(pnls)):+.2f}")


def model_snapshot(ib: IB, conn, tid: int, item, und) -> None:
    """IBKR's valuation of the position while options don't trade: a model price off the pre/post-market
    underlying. Kept apart from the marks, which only hold real prices."""
    try:
        und_px = ib.reqTickers(und)[0].marketPrice()
    except Exception:
        und_px = None
    if und_px is not None and und_px != und_px:  # NaN: no pre/post-market quote
        und_px = None
    conn.execute("UPDATE trades SET model_mark=?, model_pnl=?, model_und=?, model_at=? WHERE id=?",
                 (item.marketPrice, item.unrealizedPNL, und_px, iso(datetime.now(timezone.utc)), tid))
    print(f"IBKR model for trade {tid}: mark {item.marketPrice:.4f}, P&L {item.unrealizedPNL:+.2f}, underlying {und_px}")


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--add-fill", metavar="SYMBOL", help="Add an older opening fill from the TWS Trade Log")
    ap.add_argument("--price", type=float)
    ap.add_argument("--qty", type=float)
    ap.add_argument("--commission", type=float)
    ap.add_argument("--time", help="ISO time with offset, as shown in the Trade Log")
    args = ap.parse_args()

    ib = IB()
    try:
        ib.connect("127.0.0.1", args.port, clientId=0, readonly=True, timeout=5)
    except Exception:
        sys.exit(f"Could not reach TWS on port {args.port}. Is it open and logged in, with the API enabled?")
    conn = db_connect()

    if args.add_fill:
        if None in (args.price, args.qty, args.commission, args.time):
            sys.exit("--add-fill needs --price, --qty, --commission and --time")
        pos = [p.contract for p in ib.positions() if p.contract.secType == "OPT" and p.contract.symbol == args.add_fill.upper()]
        if len(pos) != 1:
            sys.exit(f"Expected one open {args.add_fill} option position, found {len(pos)}")
        c = pos[0]
        c.exchange = "SMART"
        ib.qualifyContracts(c)
        when = datetime.fromisoformat(args.time).astimezone(timezone.utc)
        exec_id = f"tradelog-{c.conId}-{when:%Y%m%dT%H%M%S}"
        if conn.execute("SELECT 1 FROM fills WHERE exec_id = ?", (exec_id,)).fetchone():
            print("That fill is already in the journal.")
        else:
            open_trade(ib, conn, c, when, args.price, args.qty, args.commission, exec_id)

    sync_account(ib, conn)
    sync_benchmark(ib, conn)
    sync_executions(ib, conn)
    sync_open(ib, conn)
    conn.execute("INSERT INTO sync_runs VALUES ('tws', ?, 'ok')", (iso(datetime.now(timezone.utc)),))
    conn.commit()
    ib.disconnect()


if __name__ == "__main__":
    main()
