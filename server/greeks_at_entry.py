"""Pull an option fill from TWS and estimate the Greeks at the moment it filled.

Two estimates are printed side by side:
  - IBKR's own model, via TWS calculateImpliedVolatility (uses its dividend and rate assumptions)
  - this project's Black-Scholes (server/bs.py), as a cross-check

Both take the actual fill price and the underlying's price in the minute of the fill
(from IBKR 1-minute historical bars), so the IV is the one implied by what you paid.

Needs TWS running and logged in, with the API enabled (Global Configuration > API > Settings).
Fills older than today are only returned if TWS's Trade Log is set to show 7 days.

Run (from dashboard/):
    python3 -m server.greeks_at_entry --symbol WULF
    python3 -m server.greeks_at_entry --symbol WULF --date 2026-10-02 --port 7497   # paper

The API often won't return fills from earlier days. Then pass the fill from the TWS Trade Log;
the contract is taken from your current position in that symbol:
    python3 -m server.greeks_at_entry --symbol WULF --price 0.38 --qty 3 --time "2026-10-02T14:35:17+01:00"
"""
import argparse
import sys
from datetime import date, datetime, timedelta, timezone

from types import SimpleNamespace

from ib_async import IB, ExecutionFilter, Stock

from . import bs

PORTS = {7496: "live TWS", 7497: "paper TWS", 4001: "live Gateway", 4002: "paper Gateway"}


def connect(port: int | None) -> IB:
    ib = IB()
    for p in [port] if port else list(PORTS):
        try:
            # client 0 sees fills placed by hand in TWS; read-only so nothing can be sent
            ib.connect("127.0.0.1", p, clientId=0, readonly=True, timeout=4)
            print(f"Connected to {PORTS.get(p, p)} on port {p}")
            return ib
        except Exception:
            continue
    sys.exit("Could not reach TWS or IB Gateway. Is it open, logged in, with the API enabled?")


def underlying_price_at(ib: IB, symbol: str, when: datetime) -> float | None:
    """Close of the 1-minute bar covering `when` (extended hours included)."""
    end = (when + timedelta(minutes=2)).strftime("%Y%m%d %H:%M:%S UTC")
    bars = ib.reqHistoricalData(Stock(symbol, "SMART", "USD"), endDateTime=end, durationStr="1800 S",
                                barSizeSetting="1 min", whatToShow="TRADES", useRTH=False, formatDate=2)
    before = [b for b in bars if b.date <= when]
    return (before[-1] if before else (bars[0] if bars else None)).close if bars else None


def option_mid_at(ib: IB, contract, when: datetime) -> float | None:
    """Bid/ask midpoint of the option in the minute of the fill, for comparison with the fill price."""
    end = (when + timedelta(minutes=2)).strftime("%Y%m%d %H:%M:%S UTC")
    try:
        bars = ib.reqHistoricalData(contract, endDateTime=end, durationStr="1800 S", barSizeSetting="1 min",
                                    whatToShow="MIDPOINT", useRTH=True, formatDate=2)
    except Exception:
        return None
    before = [b for b in bars if b.date <= when]
    return before[-1].close if before else None


def manual_fill(ib: IB, args) -> list:
    """Build a fill from Trade Log values, using the open option position for the contract."""
    if args.qty is None or args.time is None:
        sys.exit("--price needs --qty and --time as well")
    pos = [p for p in ib.positions() if p.contract.secType == "OPT" and p.contract.symbol == args.symbol.upper()]
    if len(pos) != 1:
        sys.exit(f"Expected one open {args.symbol} option position, found {len(pos)}")
    c = pos[0].contract
    c.exchange = "SMART"
    ib.qualifyContracts(c)
    execution = SimpleNamespace(time=datetime.fromisoformat(args.time), side="BOT", shares=args.qty,
                                price=args.price, execId="from Trade Log")
    return [SimpleNamespace(contract=c, execution=execution, commissionReport=None)]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--date", help="Only fills on this date (YYYY-MM-DD, exchange time)")
    ap.add_argument("--port", type=int, help="7496 live TWS, 7497 paper TWS (default: try all)")
    ap.add_argument("--price", type=float, help="Manual fill: price per share, from the Trade Log")
    ap.add_argument("--qty", type=float, help="Manual fill: contracts")
    ap.add_argument("--time", help="Manual fill: ISO time with offset, e.g. 2026-10-02T14:35:17+01:00")
    args = ap.parse_args()

    ib = connect(args.port)
    if args.price is not None:
        fills = manual_fill(ib, args)
    else:
        fills = ib.reqExecutions(ExecutionFilter(symbol=args.symbol.upper(), secType="OPT"))
    if args.date:
        day = date.fromisoformat(args.date)
        fills = [f for f in fills if f.execution.time.astimezone(timezone(timedelta(hours=-4))).date() == day]
    opens = [f for f in fills if f.execution.side == "BOT"]
    if not opens:
        print(f"No {args.symbol} option buys returned by TWS ({len(fills)} fills in total).")
        print("If the trade is older than today, set TWS Trade Log > 'Show trades for' to 7 days and retry.")
        ib.disconnect()
        return

    for f in sorted(opens, key=lambda f: f.execution.time):
        c, e = f.contract, f.execution
        when = e.time.astimezone(timezone.utc)
        expiry = datetime.strptime(c.lastTradeDateOrContractMonth[:8], "%Y%m%d").replace(
            hour=20, tzinfo=timezone.utc)  # 16:00 New York
        t_years = max((expiry - when).total_seconds() / (365 * 86400), 1e-6)
        dte = (expiry.date() - when.date()).days
        spot = underlying_price_at(ib, c.symbol, when)
        mid = option_mid_at(ib, c, when)
        fee = f.commissionReport.commission if f.commissionReport and f.commissionReport.commission < 1e9 else None

        print(f"\n{c.symbol} {c.lastTradeDateOrContractMonth} {c.strike:g}{c.right}  "
              f"bought {e.shares:g} @ {e.price:.2f} on {when:%a %d %b %Y %H:%M:%S} UTC  ({dte} DTE)")
        print(f"  {c.symbol} at fill: {spot if spot is not None else 'n/a'}"
              f"   option mid at fill: {mid if mid is not None else 'n/a'}"
              f"   commission: {fee if fee is not None else 'n/a'}   exec id: {e.execId}")
        if spot is None:
            print("  No underlying price for that minute; cannot compute IV.")
            continue

        # IBKR's model, from the actual fill price
        ib_calc = None
        try:
            ib.qualifyContracts(c)
            ib_calc = ib.calculateImpliedVolatility(c, e.price, spot)
        except Exception as err:
            print(f"  IBKR calculation unavailable: {err}")

        # local Black-Scholes cross-check
        iv = bs.implied_vol(c.right, e.price, spot, c.strike, t_years)
        g = bs.greeks(c.right, spot, c.strike, t_years, iv) if iv else None

        mult = float(c.multiplier or 100) * e.shares
        print(f"  {'':16}{'IBKR model':>14}{'Black-Scholes':>16}   position (x{mult:g})")
        rows = [("IV", "impliedVol", iv, 100, "%"), ("Delta", "delta", g and g["delta"], 1, ""),
                ("Gamma", "gamma", g and g["gamma"], 1, ""), ("Theta /day", "theta", g and g["theta"], 1, ""),
                ("Vega /vol pt", "vega", g and g["vega"], 1, "")]
        for label, attr, local, scale, unit in rows:
            ibv = getattr(ib_calc, attr, None) if ib_calc else None
            ib_s = f"{ibv * scale:.3f}{unit}" if ibv is not None else "n/a"
            lo_s = f"{local * scale:.3f}{unit}" if local is not None else "n/a"
            pos = f"{local * mult:+.2f}" if local is not None and label != "IV" else ""
            print(f"  {label:16}{ib_s:>14}{lo_s:>16}   {pos}")
    ib.disconnect()


if __name__ == "__main__":
    main()
