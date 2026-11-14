"""risk manager page: one option contract's live quote, the account size and a commission estimate.

read-only, through the same tws reader as the flow page (server/vol.py) on its own client ids. the page does the
scenario maths itself, from the quote and iv this returns.
"""
import math
from datetime import datetime, time
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException

from .db import connect
from .vol import SimSource, TwsSource, VolError, clean, dte_of, fill_iv, make_source, ny_today, right_of, strike_of

NY = ZoneInfo("America/New_York")
CLIENT_ID = 61  # flow uses 47-49 and the journal sync 0, so all three can be connected at once
DEFAULT_COMMISSION = 0.65  # ibkr's us option rate per contract, used until the journal has option fills

router = APIRouter(prefix="/api/risk")


def _source():
    src = make_source()
    return TwsSource(CLIENT_ID) if isinstance(src, TwsSource) else src


def _ticker(symbol: str) -> str:
    key = symbol.upper().strip()
    if not key.replace(".", "").isalnum() or len(key) > 10:
        raise HTTPException(400, "That doesn't look like a ticker.")
    return key


def _expires_at(expiry: str) -> str:
    """the 16:00 new york close on expiry day, as utc iso."""
    d = datetime.strptime(expiry, "%Y%m%d").date()
    return datetime.combine(d, time(16, 0), NY).astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")


SESSIONS = [(time(4, 0), "pre"), (time(9, 30), "regular"), (time(16, 0), "post"), (time(20, 0), "closed")]


def market_session(now: datetime | None = None) -> str:
    """us equity session by new york clock: pre (04:00-09:30), regular, post (16:00-20:00) or closed.
    outside regular hours tws streams the stock's extended-hours price but option quotes stay at the last close.
    exchange holidays aren't known here and read as a normal weekday."""
    now = (now or datetime.now(NY)).astimezone(NY)
    if now.weekday() >= 5:
        return "closed"
    out = "closed"
    for start, name in SESSIONS:
        if now.time() >= start:
            out = name
    return out


def _commission() -> dict:
    """average commission per option contract over the account's own fills."""
    with connect() as conn:
        row = conn.execute("SELECT COUNT(*) n, SUM(-commission) paid, SUM(ABS(quantity)) qty FROM ib_trades"
                           " WHERE asset = 'OPT' AND quantity <> 0").fetchone()
    if row and row["n"] and row["qty"]:
        return {"per_contract": round(row["paid"] / row["qty"], 3), "source": f"average of your last {row['n']} option fills"}
    return {"per_contract": DEFAULT_COMMISSION, "source": "IBKR standard rate"}


def _stored_nlv() -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT date, net_liquidation FROM account_daily WHERE net_liquidation > 0"
                           " ORDER BY date DESC LIMIT 1").fetchone()
    return {"value": row["net_liquidation"], "source": "last synced day", "as_of": row["date"]} if row else None


async def _live_nlv(src) -> dict | None:
    if not isinstance(src, TwsSource):
        return None
    try:
        rows = await src.ib.accountSummaryAsync()
    except Exception:
        return None
    vals = [clean(r.value) for r in rows if r.tag == "NetLiquidation" and r.currency in ("USD", "BASE")]
    vals = [v for v in vals if v]
    return {"value": vals[0], "source": "TWS, live", "as_of": datetime.now(NY).isoformat(timespec="seconds")} if vals else None


@router.get("/{symbol}")
async def overview(symbol: str) -> dict:
    """spot, the listed expiries, the account size and the commission estimate."""
    key = _ticker(symbol)
    try:
        async with _source() as src:
            und = await src.underlying(key)
            spot = await src.spot(und)
            chain = await src.chain(und)
            nlv = await _live_nlv(src)
    except VolError as e:
        raise HTTPException(e.status, str(e))
    today = ny_today()
    expiries = [{"expiry": e, "dte": dte_of(e, today), "expires_at": _expires_at(e)}
                for e in chain["expiries"] if dte_of(e, today) >= 0]
    return {
        "symbol": key,
        "session": market_session(),
        "spot": spot["spot"],
        "close": spot["close"],
        "data_type": src.data_type,
        "multiplier": float(chain["multiplier"] or 100),
        "expiries": expiries,
        "account": nlv or _stored_nlv(),
        "commission": _commission(),
    }


async def _contracts(src, und, expiry: str) -> list:
    await src.chain(und)  # sets the main trading class the contract lookup needs
    return await src.contracts(und, expiry, True)


@router.get("/{symbol}/{expiry}/strikes")
async def strikes(symbol: str, expiry: str) -> dict:
    """every listed strike of one expiry (kept in vol.db for two days after the first lookup)."""
    key = _ticker(symbol)
    if not (expiry.isdigit() and len(expiry) == 8):
        raise HTTPException(400, "Expiry should look like 20261120.")
    try:
        async with _source() as src:
            und = await src.underlying(key)
            if isinstance(src, SimSource):
                await src.spot(und)
            found = await _contracts(src, und, expiry)
    except VolError as e:
        raise HTTPException(e.status, str(e))
    return {"expiry": expiry, "strikes": sorted({strike_of(c) for c in found})}


@router.get("/{symbol}/{expiry}/quote")
async def quote(symbol: str, expiry: str, strike: float, right: str) -> dict:
    """bid, ask, mid, iv and delta of one contract, with the underlying's price read at the same time."""
    key = _ticker(symbol)
    right = right.upper()
    if right not in ("C", "P"):
        raise HTTPException(400, "Right should be C or P.")
    try:
        async with _source() as src:
            und = await src.underlying(key)
            spot = (await src.spot(und))["spot"]
            match = [c for c in await _contracts(src, und, expiry)
                     if math.isclose(strike_of(c), strike) and right_of(c) == right]
            if not match:
                raise VolError(f"{key} has no {strike:g}{right} on {expiry}.", 404)
            q = (await src.quotes(match[:1]))[0]
    except VolError as e:
        raise HTTPException(e.status, str(e))
    model_iv = q.iv
    q = fill_iv(q, spot, max(dte_of(expiry, ny_today()), 0))
    mid = round((q.bid + q.ask) / 2, 4) if q.bid and q.ask else None
    return {
        "spot": spot,
        "bid": q.bid, "ask": q.ask, "mid": mid, "last": q.last,
        "iv": q.iv, "delta": q.delta,
        "iv_source": ("simulated" if isinstance(src, SimSource) else "TWS model") if model_iv else ("from the mid" if mid else "from the last trade") if q.iv else None,
        "data_type": src.data_type,
        "session": market_session(),
        "as_of": datetime.now(NY).isoformat(timespec="seconds"),
    }
