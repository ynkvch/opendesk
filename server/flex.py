"""Import an IBKR Flex activity report into the journal. No TWS needed.

Reads a report you saved, or downloads a fresh one with the Flex Web Service using
`ibkr_flex_token` and `ibkr_flex_query_id` from data/keys.json.

Every row is keyed by IBKR's own ID (trade ID, transaction ID, report date), so importing
the same days again updates rows instead of duplicating them, and rows outside the
report's window are never deleted.

Run (from dashboard/):
    python3 -m server.flex --file data/dashboard.xml   # a saved report
    python3 -m server.flex --days 7                    # download the last 7 days
    python3 -m server.flex                             # download the query's own period
"""
import argparse
import json
import ssl
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import certifi

from .db import connect, journal_start
from .fills import add_to_trade, reduce_trade, refresh_realized

KEYS = Path(__file__).resolve().parent.parent / "data" / "keys.json"
BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService"
NY = ZoneInfo("America/New_York")  # Flex times are exchange time


# ---------------------------------------------------------------- download

def download(days: int | None) -> bytes:
    keys = json.loads(KEYS.read_text()) if KEYS.exists() else {}
    token, query = keys.get("ibkr_flex_token"), keys.get("ibkr_flex_query_id")
    if not token or not query:
        sys.exit(f"Add ibkr_flex_token and ibkr_flex_query_id to {KEYS}")
    params = {"t": token, "q": query, "v": 3}
    if days:
        params["p"] = days
    send = ET.fromstring(_get(f"{BASE}/SendRequest?{urllib.parse.urlencode(params)}"))
    if send.findtext("Status") != "Success":
        sys.exit(f"Flex request failed: {send.findtext('ErrorMessage')}")
    ref = send.findtext("ReferenceCode")
    # the report takes a few seconds to build; IBKR answers "in progress" until then
    for wait in (3, 5, 10, 20, 30):
        time.sleep(wait)
        body = _get(f"{BASE}/GetStatement?{urllib.parse.urlencode({'t': token, 'q': ref, 'v': 3})}")
        if b"<FlexQueryResponse" in body:
            return body
        msg = ET.fromstring(body).findtext("ErrorMessage") or "no report"
        if "progress" not in msg.lower():
            sys.exit(f"Flex download failed: {msg}")
    sys.exit("Flex report was still being generated after a minute; try again shortly.")


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "opendesk/0.1"})
    # python.org builds of Python ship without root certificates; use certifi's
    with urllib.request.urlopen(req, timeout=60, context=ssl.create_default_context(cafile=certifi.where())) as r:
        return r.read()


# ---------------------------------------------------------------- parsing helpers

def ts(value: str) -> datetime:
    """'20261002;093517' or '20261002' in New York time -> aware datetime."""
    fmt = "%Y%m%d;%H%M%S" if ";" in value else "%Y%m%d"
    return datetime.strptime(value, fmt).replace(tzinfo=NY)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def day(value: str) -> str:
    return f"{value[:4]}-{value[4:6]}-{value[6:8]}"


def num(a: dict, k: str) -> float | None:
    v = a.get(k)
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


# ---------------------------------------------------------------- import

def import_report(xml: bytes) -> dict:
    root = ET.fromstring(xml)
    conn = connect()
    start = journal_start(conn)  # anything earlier was deleted on purpose; don't bring it back
    start_day = start[:10].replace("-", "")
    stats = {"days": 0, "trades": 0, "cash": 0, "opened": 0, "closed": 0, "matched": 0}

    # daily account value; one row per report date even though Flex repeats the prior day
    equity = {e.attrib["reportDate"]: e.attrib for e in root.iter("EquitySummaryByReportDateInBase")}
    realized_by_day: dict[str, float] = {}
    for t in root.iter("Trade"):
        if t.attrib.get("levelOfDetail", "EXECUTION") == "EXECUTION":
            d = t.attrib["tradeDate"]
            realized_by_day[d] = realized_by_day.get(d, 0.0) + (num(t.attrib, "fifoPnlRealized") or 0.0)
    unrealized_by_day: dict[str, float] = {}
    for p in root.iter("OpenPosition"):
        d = p.attrib.get("reportDate")
        if d:
            unrealized_by_day[d] = unrealized_by_day.get(d, 0.0) + (num(p.attrib, "fifoPnlUnrealized") or 0.0)
    for d, a in equity.items():
        if d < start_day:
            continue
        # the start day's realized P&L belongs to the trade that ended the old period
        realized = 0.0 if d == start_day else realized_by_day.get(d, 0.0)
        conn.execute("INSERT OR REPLACE INTO account_daily VALUES (?,?,?,?)",
                     (day(d), num(a, "total") or 0.0, realized, unrealized_by_day.get(d, 0.0)))
        stats["days"] += 1

    # position history, used to rebuild trades opened before the report window and their daily path
    history = position_history(root)

    # every trade, all asset classes, for the cost breakdown
    for t in root.iter("Trade"):
        a = t.attrib
        if a.get("levelOfDetail", "EXECUTION") != "EXECUTION":
            continue
        when = ts(a["dateTime"])
        if iso(when) <= start:
            continue
        conn.execute(
            "INSERT OR REPLACE INTO ib_trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (a["tradeID"], a.get("ibExecID"), iso(when), day(a["tradeDate"]), a["symbol"].strip(),
             a.get("underlyingSymbol") or None, a["assetCategory"], a.get("putCall") or None, num(a, "strike"),
             day(a["expiry"]) if a.get("expiry") else None, a["buySell"], a.get("openCloseIndicator") or None,
             num(a, "quantity") or 0.0, num(a, "tradePrice") or 0.0, num(a, "ibCommission") or 0.0,
             num(a, "netCash"), num(a, "fifoPnlRealized"), int(a["conid"]) if a.get("conid") else None,
             num(a, "multiplier")))
        stats["trades"] += 1
        if a["assetCategory"] in ("OPT", "STK"):
            journal_fill(conn, a, when, stats, history)

    # options that expired, were exercised or assigned: no closing trade is printed for these
    for e in root.iter("OptionEAE"):
        a = e.attrib
        if a.get("transactionType") in ("Expiration", "Assignment", "Exercise") and a.get("conid"):
            row = conn.execute("SELECT t.id FROM trades t JOIN legs l ON l.trade_id = t.id "
                               "WHERE l.conid = ? AND t.status = 'open'", (int(a["conid"]),)).fetchone()
            if row:
                when = ts(a["date"]).replace(hour=16)
                close_journal_trade(conn, row["id"], when, num(a, "tradePrice") or 0.0, abs(num(a, "quantity") or 0.0),
                                    0.0, f"eae-{a['conid']}-{a['date']}", a.get("transactionType"))
                stats["closed"] += 1

    # fees, interest, deposits and withdrawals
    for c in root.iter("CashTransaction"):
        a = c.attrib
        if a.get("levelOfDetail", "DETAIL") != "DETAIL" or not a.get("transactionID"):
            continue
        if day((a.get("reportDate") or a["dateTime"])[:8]) < start[:10]:
            continue
        amount = num(a, "amount") or 0.0
        fx = num(a, "fxRateToBase") or (1.0 if a.get("currency") == "USD" else 0.0)
        conn.execute("INSERT OR REPLACE INTO cash_transactions VALUES (?,?,?,?,?,?,?)",
                     (a["transactionID"], day((a.get("reportDate") or a["dateTime"])[:8]), a.get("type", ""),
                      a.get("description", ""), amount, a.get("currency", "USD"), amount * fx))
        stats["cash"] += 1

    daily_paths(conn, history)

    stmts = list(root.iter("FlexStatement"))
    span = f"{stmts[0].attrib.get('fromDate')}-{stmts[-1].attrib.get('toDate')}" if stmts else "empty"
    conn.execute("INSERT INTO sync_runs VALUES ('flex', ?, ?)",
                 (iso(datetime.now(timezone.utc)), f"{span}: " + ", ".join(f"{k} {v}" for k, v in stats.items())))
    conn.commit()
    return stats


def position_history(root) -> dict:
    """conid -> {'first': earliest report date held, 'cost': cost basis per unit, 'qty': position,
    'prices': {date: closing price}} from Open Positions and Prior Period Positions."""
    h: dict[int, dict] = {}
    for o in root.iter("OpenPosition"):
        a = o.attrib
        if not a.get("conid"):
            continue
        e = h.setdefault(int(a["conid"]), {"first": None, "cost": None, "qty": None, "prices": {}})
        d = day(a["reportDate"])
        if e["first"] is None or d < e["first"]:
            e["first"], e["cost"], e["qty"] = d, num(a, "costBasisPrice"), abs(num(a, "position") or 0)
        if num(a, "markPrice") is not None:
            e["prices"][d] = num(a, "markPrice")
    for p in root.iter("PriorPeriodPosition"):
        a = p.attrib
        if a.get("conid") and num(a, "price") is not None:
            e = h.setdefault(int(a["conid"]), {"first": None, "cost": None, "qty": None, "prices": {}})
            e["prices"][day(a["date"])] = num(a, "price")
    return h


def open_trade_for(conn, conid: int):
    return conn.execute("SELECT t.* FROM trades t JOIN legs l ON l.trade_id = t.id "
                        "WHERE l.conid = ? AND t.status = 'open'", (conid,)).fetchone()


def journal_fill(conn, a: dict, when: datetime, stats: dict, history: dict) -> None:
    """Put an option or stock fill into the journal, or correct the one already there."""
    conid = int(a["conid"])
    exec_id = a.get("ibExecID") or f"flex-{a['tradeID']}"
    commission = -(num(a, "ibCommission") or 0.0)
    qty = abs(num(a, "quantity") or 0.0)
    price = num(a, "tradePrice") or 0.0
    seen = conn.execute("SELECT id, trade_id, commission FROM fills WHERE exec_id = ?", (exec_id,)).fetchone()
    if seen:
        # TWS can record a fill before its commission report arrives; the statement has the real figure
        if not seen["commission"] and commission:
            conn.execute("UPDATE fills SET commission=? WHERE id=?", (commission, seen["id"]))
            conn.execute("UPDATE trades SET commissions=commissions+? WHERE id=?", (commission, seen["trade_id"]))
            refresh_realized(conn, seen["trade_id"])
            stats["matched"] += 1
        return
    opening = a.get("openCloseIndicator", "").startswith("O")
    # a fill added by hand from the Trade Log has no IBKR execution ID: same contract and direction within two minutes
    # (TWS fills carry the same execution ID as Flex and were skipped above)
    lo, hi = iso(when - timedelta(minutes=2)), iso(when + timedelta(minutes=2))
    near = conn.execute("SELECT f.id, f.trade_id FROM fills f JOIN legs l ON l.trade_id = f.trade_id "
                        "WHERE l.conid = ? AND f.exec_id LIKE 'tradelog-%' AND f.action = ? AND f.time BETWEEN ? AND ?",
                        (conid, "OPEN" if opening else "CLOSE", lo, hi)).fetchone()
    if near:
        old = conn.execute("SELECT commission FROM fills WHERE id = ?", (near["id"],)).fetchone()["commission"]
        conn.execute("UPDATE fills SET exec_id=?, time=?, price=?, quantity=?, commission=? WHERE id=?",
                     (exec_id, iso(when), price, qty, commission, near["id"]))
        conn.execute("UPDATE trades SET commissions = commissions - ? + ? WHERE id = ?", (old, commission, near["trade_id"]))
        stats["matched"] += 1
        return
    existing = open_trade_for(conn, conid)
    if opening and a["buySell"] == "BUY":
        if existing and existing["open_estimated"]:
            # the real purchase of a position first seen mid-holding: replace the estimate
            conn.execute("UPDATE trades SET opened_at=?, entry_price=?, commissions=commissions+?, open_estimated=0 "
                         "WHERE id=?", (iso(when), price, commission, existing["id"]))
            conn.execute("UPDATE fills SET exec_id=?, time=?, price=?, commission=? WHERE trade_id=? AND action='OPEN'",
                         (exec_id, iso(when), price, commission, existing["id"]))
            stats["matched"] += 1
        elif existing:
            add_to_trade(conn, existing["id"], iso(when), price, qty, commission, exec_id, describe(a))
        else:
            open_journal_trade(conn, a, iso(when), price, qty, commission, exec_id, conid, estimated=False)
            stats["opened"] += 1
    elif not opening and a["buySell"] == "SELL":
        if not existing:
            # sold something bought before the report window: rebuild the opening from position history
            h = history.get(conid)
            if not h or not h["first"] or not h["cost"]:
                return
            start = datetime.fromisoformat(h["first"]).replace(hour=16, tzinfo=NY)  # that session's close
            open_journal_trade(conn, a, iso(start), h["cost"], h["qty"] or qty, 0.0, f"est-open-{conid}", conid,
                               estimated=True)
            existing = open_trade_for(conn, conid)
            stats["opened"] += 1
        if close_journal_trade(conn, existing["id"], when, price, qty, commission, exec_id, None):
            stats["closed"] += 1


def describe(a: dict) -> str:
    if a["assetCategory"] == "STK":
        return f"{a['symbol'].strip()} shares"
    exp = datetime.strptime(a["expiry"], "%Y%m%d")
    return f"{a.get('underlyingSymbol')} {exp:%d%b%y}".upper() + f" {float(a['strike']):g} {a['putCall']}"


def open_journal_trade(conn, a, opened_at, price, qty, commission, exec_id, conid, estimated) -> None:
    """New long position. For options, entry IV and Greeks are filled in by the next TWS sync."""
    stock = a["assetCategory"] == "STK"
    mult = num(a, "multiplier") or (1 if stock else 100)
    right = "S" if stock else a["putCall"]
    underlying = a["symbol"].strip() if stock else a["underlyingSymbol"]
    strategy = "Long stock" if stock else f"Long {'call' if right == 'C' else 'put'}"
    dte = 0 if stock else (datetime.strptime(a["expiry"], "%Y%m%d").date()
                           - datetime.fromisoformat(opened_at.replace("Z", "+00:00")).date()).days
    cur = conn.execute(
        "INSERT INTO trades (underlying, strategy, bias, status, quantity, opened_at, entry_price, max_risk, commissions,"
        " und_entry, und_high, und_low, pos_high, pos_low, iv_entry, dte_entry, delta_entry, gamma_entry, theta_entry,"
        " vega_entry, source, asset, multiplier, open_estimated)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (underlying, strategy, "bearish" if right == "P" else "bullish", "open", qty, opened_at, price,
         round(price * mult * qty, 2), commission, price if stock else 0, price if stock else 0, price if stock else 0,
         price, price, 0, dte, qty if stock else 0, 0, 0, 0, "flex", a["assetCategory"], mult, int(estimated)))
    tid = cur.lastrowid
    conn.execute("INSERT INTO legs (trade_id, side, right_, strike, expiry, entry_price, iv_entry, delta_entry, conid)"
                 " VALUES (?,?,?,?,?,?,?,?,?)", (tid, "BUY", right, 0 if stock else float(a["strike"]),
                                                 "" if stock else day(a["expiry"]), price, 0, 1 if stock else 0, conid))
    conn.execute("INSERT INTO fills (trade_id, exec_id, time, action, side, description, quantity, price, commission)"
                 " VALUES (?,?,?,?,?,?,?,?,?)",
                 (tid, exec_id, opened_at, "OPEN", "BOT", describe(a) + (" (cost basis, bought earlier)" if estimated else ""),
                  qty, price, commission))


def close_journal_trade(conn, tid, when, price, qty, commission, exec_id, how) -> bool:
    """A closing fill, or an expiry/exercise/assignment. True once the whole position is closed."""
    t = conn.execute("SELECT * FROM trades WHERE id = ?", (tid,)).fetchone()
    held = t["quantity"] - conn.execute("SELECT COALESCE(SUM(quantity), 0) FROM fills WHERE trade_id = ? AND action = 'CLOSE'",
                                        (tid,)).fetchone()[0]
    desc = conn.execute("SELECT description FROM fills WHERE trade_id = ? AND action = 'OPEN'", (tid,)).fetchone()
    desc = (desc["description"].split(" (")[0] if desc else t["underlying"]) + (f" ({how.lower()})" if how else "")
    return reduce_trade(conn, tid, iso(when), price, min(qty, held) if qty else held, commission, exec_id, desc)


def daily_paths(conn, history: dict) -> None:
    """Daily P&L path, MAE/MFE and highs/lows from statement closing prices, for trades without TWS marks.
    Trades the TWS sync has tracked (they have session closes) keep its hourly path and live underlying."""
    trades = conn.execute("SELECT t.*, l.conid FROM trades t JOIN legs l ON l.trade_id = t.id WHERE t.source = 'flex'"
                          " AND NOT EXISTS (SELECT 1 FROM option_daily o WHERE o.trade_id = t.id)").fetchall()
    for t in trades:
        h = history.get(t["conid"])
        if not h or not h["prices"]:
            continue
        start = t["opened_at"][:10]
        end = (t["closed_at"] or "9999")[:10]
        days = sorted(d for d in h["prices"] if start <= d < end)
        mult, qty = t["multiplier"], t["quantity"]
        stock = t["asset"] == "STK"
        # the statement prices the position itself; for options that is not the underlying, which Flex doesn't give
        und = (lambda px: px) if stock else (lambda px: t["und_last"] or t["und_entry"])
        open_fee = t["commissions"] if t["status"] == "open" else 0.0
        marks = [(f"{d}T20:00:00Z", und(h["prices"][d]), round((h["prices"][d] - t["entry_price"]) * mult * qty - open_fee, 2))
                 for d in days]
        if t["status"] == "closed":
            marks.append((t["closed_at"], und(t["exit_price"]), t["realized_pnl"]))
        if not marks:
            continue
        conn.execute("DELETE FROM marks WHERE trade_id = ?", (t["id"],))
        conn.executemany("INSERT OR REPLACE INTO marks (trade_id, time, underlying, pnl) VALUES (?,?,?,?)",
                         [(t["id"], *m) for m in marks])
        pnls = [m[2] for m in marks]
        prices = [h["prices"][d] for d in days] + [t["entry_price"]] + ([t["exit_price"]] if t["status"] == "closed" else [])
        conn.execute("UPDATE trades SET mae=?, mfe=?, pos_high=?, pos_low=?, last_update=?"
                     + (", und_last=?, und_high=?, und_low=?" if stock else "") + " WHERE id=?",
                     (min(0.0, min(pnls)), max(0.0, max(pnls)), max(prices), min(prices), marks[-1][0])
                     + ((marks[-1][1], max(prices), min(prices)) if stock else ()) + (t["id"],))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", help="Import a saved Flex XML report instead of downloading")
    ap.add_argument("--days", type=int, help="Download only the last N days (overrides the query's period)")
    args = ap.parse_args()
    xml = Path(args.file).read_bytes() if args.file else download(args.days)
    stats = import_report(xml)
    print("Flex import: " + ", ".join(f"{k} {v}" for k, v in stats.items()))


if __name__ == "__main__":
    main()
