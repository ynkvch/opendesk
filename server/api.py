"""HTTP API for the journal UI.

Run (from the project folder):  uvicorn server.api:app --port 8000 --reload
"""
import sqlite3
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import bs
from .db import connect
from .signals.routes import router as signals_router
from .signals.store import DB_PATH as SIGNALS_DB
from .vol import router as vol_router

NY = ZoneInfo("America/New_York")
app = FastAPI(title="opendesk")
app.include_router(signals_router)
app.include_router(vol_router)


@app.on_event("startup")
async def _start_vol_recording() -> None:
    from .vol import start_background
    start_background()
DIST = Path(__file__).resolve().parent.parent / "web" / "dist"


def _rows(sql: str, args: tuple = ()) -> list[dict]:
    with connect() as conn:
        return [dict(r) for r in conn.execute(sql, args)]


def _start() -> str:
    """Journal start (ISO, UTC). Everything earlier stays in the database but isn't shown."""
    row = _rows("SELECT value FROM settings WHERE key = 'journal_start'")
    return row[0]["value"] if row else ""


def _legs_label(legs: list[dict]) -> str:
    """Compact contract label, e.g. '16 OCT 640C / 650C'."""
    if not legs:
        return ""
    if legs[0]["right_"] == "S":
        return "Shares"
    exp = datetime.fromisoformat(legs[0]["expiry"]).strftime("%d %b").upper()
    return f"{exp} " + " / ".join(f"{lg['strike']:g}{lg['right_']}" for lg in legs)


def _leg_types(legs: list[dict]) -> list[str]:
    """Distinct leg kinds in a trade, e.g. ['Long call', 'Short call']."""
    names = {"C": "call", "P": "put", "S": "stock"}
    kinds = {f"{'Long' if lg['side'] == 'BUY' else 'Short'} {names[lg['right_']]}" for lg in legs}
    return sorted(kinds)


def _hold_hours(t: dict) -> float | None:
    if not t["closed_at"]:
        return None
    a = datetime.fromisoformat(t["opened_at"].replace("Z", "+00:00"))
    b = datetime.fromisoformat(t["closed_at"].replace("Z", "+00:00"))
    return (b - a).total_seconds() / 3600


@app.get("/api/trades")
def list_trades() -> list[dict]:
    trades = _rows("SELECT * FROM trades WHERE opened_at > ? ORDER BY opened_at DESC", (_start(),))
    legs = _rows("SELECT * FROM legs ORDER BY trade_id, id")
    last_marks = {r["trade_id"]: r["pnl"] for r in _rows(
        "SELECT trade_id, pnl FROM marks m WHERE time = (SELECT MAX(time) FROM marks WHERE trade_id = m.trade_id)")}
    by_trade: dict[int, list[dict]] = {}
    for lg in legs:
        by_trade.setdefault(lg["trade_id"], []).append(lg)
    out = []
    for t in trades:
        pnl = t["realized_pnl"] if t["status"] == "closed" else last_marks.get(t["id"])
        out.append({
            **{k: t[k] for k in ("id", "underlying", "strategy", "bias", "status", "quantity", "opened_at",
                                 "closed_at", "entry_price", "exit_price", "max_risk", "mae", "mfe",
                                 "iv_entry", "iv_rank_entry", "dte_entry", "delta_entry", "theta_entry", "source",
                                 "commissions", "asset", "multiplier", "open_estimated")},
            "contract": _legs_label(by_trade.get(t["id"], [])),
            "leg_types": _leg_types(by_trade.get(t["id"], [])),
            "pnl": pnl,
            "r_multiple": None if pnl is None else pnl / t["max_risk"],
            "hold_hours": _hold_hours(t),
            "has_thesis": bool(t["thesis"].strip()),
        })
    return out


@app.get("/api/trades/{trade_id}")
def get_trade(trade_id: int) -> dict:
    rows = _rows("SELECT * FROM trades WHERE id = ?", (trade_id,))
    if not rows:
        raise HTTPException(404, "Trade not found")
    t = rows[0]
    legs = _rows("SELECT * FROM legs WHERE trade_id = ? ORDER BY id", (trade_id,))
    marks = _rows("SELECT time, underlying, pnl FROM marks WHERE trade_id = ? ORDER BY time", (trade_id,))
    pnl = t["realized_pnl"] if t["status"] == "closed" else (marks[-1]["pnl"] if marks else None)
    return {
        **t,
        "contract": _legs_label(legs),
        "pnl": pnl,
        "r_multiple": None if pnl is None else pnl / t["max_risk"],
        "hold_hours": _hold_hours(t),
        "legs": legs,
        # IBKR execution IDs stay in the database for de-duplication; the UI has no use for them
        "fills": _rows("SELECT id, trade_id, time, action, side, description, quantity, price, commission"
                       " FROM fills WHERE trade_id = ? ORDER BY time, id", (trade_id,)),
        "marks": marks,
    }


def _session_close(d: date) -> datetime:
    return datetime.combine(d, time(16), NY)


@app.get("/api/trades/{trade_id}/theta")
def theta(trade_id: int) -> dict:
    """Extrinsic value at each session close, the theta at that close, and a projection to expiry
    from the latest close with the underlying and IV held where they closed."""
    rows = _rows("SELECT * FROM trades WHERE id = ?", (trade_id,))
    if not rows:
        raise HTTPException(404, "Trade not found")
    t = rows[0]
    legs = _rows("SELECT * FROM legs WHERE trade_id = ?", (trade_id,))
    if len(legs) != 1 or legs[0]["right_"] not in ("C", "P"):
        return {"available": False, "reason": "The theta chart covers single-leg option trades only."}
    leg = legs[0]
    right, k = leg["right_"], leg["strike"]
    sign = 1 if leg["side"] == "BUY" else -1
    mult = t["multiplier"] * t["quantity"] * sign
    expiry = _session_close(date.fromisoformat(leg["expiry"]))

    def years(at: datetime) -> float:
        return max((expiry - at).total_seconds() / (365 * 86400), 0.0)

    def intrinsic(s: float) -> float:
        return max(0.0, s - k) if right == "C" else max(0.0, k - s)

    history = []
    for r in _rows("SELECT date, underlying, option FROM option_daily WHERE trade_id = ? ORDER BY date", (trade_id,)):
        ty = years(_session_close(date.fromisoformat(r["date"])))
        iv = bs.implied_vol(right, r["option"], r["underlying"], k, ty) if ty > 0 else None
        history.append({
            "date": r["date"], "underlying": r["underlying"], "option": r["option"], "iv": iv,
            "extrinsic": (r["option"] - intrinsic(r["underlying"])) * mult,
            "theta": bs.greeks(right, r["underlying"], k, ty, iv)["theta"] * mult if iv else None,
        })

    projection = []
    last = next((h for h in reversed(history) if h["iv"]), None)
    if last:
        s, iv = last["underlying"], last["iv"]
        d = date.fromisoformat(last["date"])
        prev = bs.price(right, s, k, years(_session_close(d)), iv)
        while d < expiry.date():
            d += timedelta(days=1)
            p = bs.price(right, s, k, years(_session_close(d)), iv)
            projection.append({"date": d.isoformat(), "extrinsic": (p - intrinsic(s)) * mult, "decay": (prev - p) * mult})
            prev = p

    return {
        "available": True,
        "expiry": leg["expiry"],
        "strike": k,
        "right": right,
        "extrinsic_entry": (t["entry_price"] - intrinsic(t["und_entry"])) * mult if t["und_entry"] else None,
        "history": history,
        "projection": projection,
    }


class Notes(BaseModel):
    thesis: str | None = None
    post_mortem: str | None = None


@app.patch("/api/trades/{trade_id}/notes")
def update_notes(trade_id: int, notes: Notes) -> dict:
    fields = {k: v for k, v in notes.model_dump().items() if v is not None}
    if fields:
        with connect() as conn:
            sets = ", ".join(f"{k} = ?" for k in fields)
            cur = conn.execute(f"UPDATE trades SET {sets} WHERE id = ?", (*fields.values(), trade_id))
            if cur.rowcount == 0:
                raise HTTPException(404, "Trade not found")
    return get_trade(trade_id)


@app.get("/api/account")
def account() -> list[dict]:
    """Daily account value with the SPY close for the same day, for comparison."""
    # SPY has no close on market holidays (or today, before the close) while the account still has a value;
    # carry the last close forward so the comparison line has no gaps
    return _rows(
        "SELECT a.*, (SELECT b.close FROM benchmark_daily b WHERE b.symbol = 'SPY' AND b.date <= a.date"
        " ORDER BY b.date DESC LIMIT 1) AS spy FROM account_daily a WHERE a.date >= ? ORDER BY a.date",
        (_start()[:10],))


MARKET_DATA_WORDS = ("LEVEL 1", "TAPE", "OPRA", " NP", "NASDAQ", "NYSE", "AMEX", "CBOE", "MARKET DATA")


def _is_market_data(desc: str) -> bool:
    d = desc.upper()
    return "MAINTENANCE" not in d and any(w in d for w in MARKET_DATA_WORDS)


@app.get("/api/costs")
def costs() -> dict:
    """Everything trading has cost: commissions by asset class, market data, other fees, interest."""
    start = _start()
    trades = _rows("SELECT trade_date, asset, commission FROM ib_trades WHERE time > ?", (start,))
    cash = _rows("SELECT date, type, description, amount_base FROM cash_transactions WHERE date >= ?", (start[:10],))
    months: dict[str, dict] = {}

    def bucket(d: str) -> dict:
        return months.setdefault(d[:7], {"month": d[:7], "commissions": 0.0, "market_data": 0.0, "other_fees": 0.0,
                                         "interest": 0.0})

    by_asset = {"OPT": 0.0, "STK": 0.0, "CASH": 0.0}
    for t in trades:
        paid = -t["commission"]
        by_asset[t["asset"]] = by_asset.get(t["asset"], 0.0) + paid
        bucket(t["trade_date"])["commissions"] += paid
    market_data = other = interest = 0.0
    for c in cash:
        paid = -c["amount_base"]
        if c["type"] == "Other Fees":
            if _is_market_data(c["description"]):
                market_data += paid
                bucket(c["date"])["market_data"] += paid
            else:
                other += paid
                bucket(c["date"])["other_fees"] += paid
        elif "Interest" in c["type"]:
            interest += paid
            bucket(c["date"])["interest"] += paid
    # the subscriptions charged in the latest month, so it's clear what is being paid for
    md = [c for c in cash if c["type"] == "Other Fees" and _is_market_data(c["description"])]
    latest = max((c["date"][:7] for c in md), default=None)
    subs = [{"description": c["description"], "amount": -c["amount_base"]} for c in md if c["date"][:7] == latest]
    dates = [t["trade_date"] for t in trades] + [c["date"] for c in cash]
    commissions = sum(by_asset.values())
    return {
        "from": start[:10] or min(dates, default=None),
        "to": max(dates, default=None),
        "total": commissions + market_data + other + interest,
        "commissions": commissions,
        "by_asset": by_asset,
        "market_data": market_data,
        "other_fees": other,
        "interest": interest,
        "by_month": [months[k] for k in sorted(months)],
        "subscriptions_month": latest,
        "subscriptions": sorted(subs, key=lambda x: -x["amount"]),
    }


TRADING_DAYS = 252
MIN_RETURNS = 5  # fewer daily returns than this and the ratios can't be worked out; short windows are noisy


def _risk_free(first: str, last: str) -> float:
    """average 13-week t-bill yield over the period, from the regime page's data; the black-scholes rate without it."""
    try:
        conn = sqlite3.connect(f"file:{SIGNALS_DB}?mode=ro", uri=True)
        row = conn.execute("SELECT AVG(value) FROM regime_obs WHERE series = 'DGS3MO' AND date BETWEEN ? AND ?",
                           (first, last)).fetchone()
        conn.close()
        if row and row[0] is not None:
            return row[0] / 100
    except sqlite3.Error:
        pass
    return bs.RATE


def _portfolio_stats(since: str | None = None) -> dict:
    """sharpe, max drawdown, and beta and alpha against spy, from daily account values. deposits and withdrawals
    are taken out of each day's change so moving cash is not counted as a gain or a loss. since (YYYY-MM-DD) limits
    them to the dashboard's time range: that day's close is the starting point."""
    days = [d for d in account() if not since or d["date"] >= since]
    flows: dict[str, float] = {}
    for c in _rows("SELECT date, amount_base FROM cash_transactions WHERE type = 'Deposits/Withdrawals' AND date >= ?",
                   (max(_start()[:10], since or ""),)):
        flows[c["date"]] = flows.get(c["date"], 0.0) + c["amount_base"]
    acct, spy = [], []
    for prev, cur in zip(days, days[1:]):
        if prev["net_liquidation"] <= 0:
            continue
        acct.append((cur["net_liquidation"] - flows.get(cur["date"], 0.0)) / prev["net_liquidation"] - 1)
        spy.append(cur["spy"] / prev["spy"] - 1 if cur["spy"] and prev["spy"] else 0.0)
    empty = {"sharpe": None, "max_drawdown": None, "beta": None, "alpha": None, "risk_free": None, "return_days": len(acct)}
    if len(acct) < MIN_RETURNS:
        return empty

    def mean(xs: list[float]) -> float:
        return sum(xs) / len(xs)

    def sd(xs: list[float]) -> float:
        m = mean(xs)
        return (sum((x - m) ** 2 for x in xs) / (len(xs) - 1)) ** 0.5

    rf = _risk_free(days[0]["date"], days[-1]["date"])
    ex = [r - rf / TRADING_DAYS for r in acct]
    ex_spy = [r - rf / TRADING_DAYS for r in spy]
    equity, peak, drawdown = 1.0, 1.0, 0.0
    for r in acct:
        equity *= 1 + r
        peak = max(peak, equity)
        drawdown = min(drawdown, equity / peak - 1)
    var_spy = sd(spy) ** 2
    beta = (sum((a - mean(acct)) * (b - mean(spy)) for a, b in zip(acct, spy)) / (len(acct) - 1) / var_spy
            if var_spy > 0 else None)
    return {
        "sharpe": mean(ex) / sd(ex) * TRADING_DAYS ** 0.5 if sd(ex) > 0 else None,
        "max_drawdown": drawdown,
        "beta": beta,
        # jensen's alpha: the account's excess return beyond what its beta to spy explains, annualized
        "alpha": TRADING_DAYS * (mean(ex) - beta * mean(ex_spy)) if beta is not None else None,
        "risk_free": rf,
        "return_days": len(acct),
    }


@app.get("/api/summary")
def summary(since: str | None = None) -> dict:
    """closed-trade and account stats. since (YYYY-MM-DD, the dashboard's time range) keeps the trades closed after
    that day and the account values from it on."""
    start = _start()
    closed = _rows("SELECT * FROM trades WHERE status = 'closed' AND opened_at > ?", (start,))
    open_n = _rows("SELECT COUNT(*) n FROM trades WHERE status = 'open' AND opened_at > ?", (start,))[0]["n"]
    pnls = [t["realized_pnl"] for t in closed]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    rs = [t["realized_pnl"] / t["max_risk"] for t in closed]
    holds = [h for t in closed if (h := _hold_hours(t)) is not None]

    def group(key: str) -> list[dict]:
        g: dict[str, list[float]] = {}
        for t in closed:
            g.setdefault(t[key], []).append(t["realized_pnl"])
        return sorted(({"name": k, "trades": len(v), "pnl": sum(v), "win_rate": sum(p > 0 for p in v) / len(v)}
                       for k, v in g.items()), key=lambda x: -x["pnl"])

    def avg(xs: list[float]) -> float | None:
        return sum(xs) / len(xs) if xs else None

    # option fills only: per-contract and %-of-premium figures don't apply to shares
    f = _rows("SELECT COUNT(*) n, COALESCE(SUM(f.commission), 0) fees, COALESCE(SUM(f.quantity), 0) contracts,"
              " COALESCE(SUM(f.price * f.quantity * t.multiplier), 0) premium FROM fills f"
              " JOIN trades t ON t.id = f.trade_id WHERE t.asset = 'OPT' AND f.action = 'OPEN' AND t.opened_at > ?",
              (start,))[0]
    gross_wins = sum(t["realized_pnl"] + t["commissions"] for t in closed if t["realized_pnl"] + t["commissions"] > 0)
    as_of = _rows("SELECT MAX(t) AS t FROM (SELECT MAX(last_update) AS t FROM trades"
                  " UNION ALL SELECT MAX(time) FROM fills)")[0]["t"]
    return {
        "as_of": as_of,
        "journal_start": start or None,
        "closed_trades": len(closed),
        "open_trades": open_n,
        "net_pnl": sum(pnls),
        "win_rate": len(wins) / len(pnls) if pnls else None,
        "avg_win": avg(wins),
        "avg_loss": avg(losses),
        "profit_factor": (sum(wins) / -sum(losses)) if losses and sum(losses) < 0 else None,
        "expectancy": avg(pnls),
        "avg_r": avg(rs),
        "avg_hold_hours": avg(holds),
        "avg_mae": avg([t["mae"] for t in closed]),
        "avg_mfe": avg([t["mfe"] for t in closed]),
        # share of the best open profit that was actually kept on winners
        "mfe_capture": avg([t["realized_pnl"] / t["mfe"] for t in closed if t["realized_pnl"] > 0 and t["mfe"] > 0]),
        "commissions": sum(t["commissions"] for t in closed),
        # every fill, open trades included: what trading has cost so far
        "fees": {
            "total": f["fees"],
            "fills": f["n"],
            "contracts": f["contracts"],
            "per_contract": f["fees"] / f["contracts"] if f["contracts"] else None,
            "premium": f["premium"],
            "pct_of_premium": f["fees"] / f["premium"] if f["premium"] else None,
            "pct_of_gross_wins": f["fees"] / gross_wins if gross_wins else None,
        },
        **_portfolio_stats(since),
        "by_strategy": group("strategy"),
        "by_underlying": group("underlying"),
    }


if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str) -> FileResponse:
        """Serve the built UI; unknown paths (e.g. /journal) fall back to index.html."""
        f = (DIST / path).resolve()
        inside = f.is_relative_to(DIST.resolve())
        if path and inside and f.is_file():
            return FileResponse(f)
        # index.html names the current hashed bundle; without this header browsers reuse a cached copy after a
        # rebuild and keep loading the old UI. The hashed files under /assets can stay cached.
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})
    if since:
        closed = [t for t in closed if t["closed_at"] and t["closed_at"][:10] > since]
