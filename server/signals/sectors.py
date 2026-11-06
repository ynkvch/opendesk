"""Sector performance: daily closes of the 11 Select Sector SPDR ETFs, SPY and QQQ.

Source: Yahoo Finance's chart API (no key; prices 15 minutes delayed in the session). Five years of daily bars
are refetched on each run because Yahoo revises the adjusted closes after every dividend.
"""
import json
from datetime import datetime, timedelta, timezone

from .http import FetchError, fetch_json
from .store import now

SECTORS = [
    ("XLK", "Technology"), ("XLC", "Communication Services"), ("XLY", "Consumer Discretionary"),
    ("XLF", "Financials"), ("XLI", "Industrials"), ("XLB", "Materials"), ("XLE", "Energy"),
    ("XLV", "Health Care"), ("XLP", "Consumer Staples"), ("XLU", "Utilities"), ("XLRE", "Real Estate"),
]
BENCHMARKS = [("SPY", "S&P 500"), ("QQQ", "Nasdaq-100")]
# not sectors, but on the rotation graph as a regime's favoured asset (gold for risk-off)
EXTRAS = [("GLD", "Gold")]
URL = "https://query1.finance.yahoo.com/v8/finance/chart/{}?range=5y&interval=1d&events=div%2Csplits"
# a page read older than this triggers a fresh fetch
STALE_MINUTES = 15


def _bars(symbol: str) -> list[tuple[str, float, float]]:
    # Yahoo answers 429 to a full browser user agent sent without its cookies, but not to this short one
    res = fetch_json(URL.format(symbol), ua="Mozilla/5.0", retries=2)["chart"]["result"][0]
    off = res["meta"].get("gmtoffset", 0)
    close = res["indicators"]["quote"][0]["close"]
    adj = res["indicators"]["adjclose"][0]["adjclose"]
    out = []
    for ts, c, a in zip(res.get("timestamp", []), close, adj):
        if c is None or a is None:
            continue
        day = datetime.fromtimestamp(ts + off, timezone.utc).strftime("%Y-%m-%d")
        out.append((day, c, a))
    return out


def collect(conn) -> dict:
    """Fetch every symbol; a symbol that fails keeps its stored history."""
    rows, errors = 0, []
    for symbol, _ in SECTORS + BENCHMARKS + EXTRAS:
        try:
            bars = _bars(symbol)
        except (FetchError, KeyError, IndexError, TypeError, json.JSONDecodeError) as e:
            errors.append(f"{symbol}: {e}")
            continue
        conn.execute("DELETE FROM sector_daily WHERE symbol = ?", (symbol,))
        conn.executemany("INSERT INTO sector_daily VALUES (?, ?, ?, ?)", [(symbol, *b) for b in bars])
        rows += len(bars)
    conn.commit()
    return {"rows": rows, "errors": errors}


def run(conn) -> None:
    """Collect and record the run, like the scheduled sources, so the page can show when data last arrived."""
    run_id = conn.execute("INSERT INTO runs (source, started_at) VALUES ('sectors', ?)", (now(),)).lastrowid
    conn.commit()
    try:
        res = collect(conn)
        failed = len(res["errors"])
        ok = 0 if failed == len(SECTORS) + len(BENCHMARKS) + len(EXTRAS) else 1
        msg = f"{res['rows']} rows" + (f"; {'; '.join(res['errors'][:5])}" if failed else "")
    except Exception as e:  # recorded on the run so the page shows it
        ok, msg = 0, f"{type(e).__name__}: {e}"
    conn.execute("UPDATE runs SET finished_at = ?, ok = ?, message = ? WHERE id = ?", (now(), ok, msg[:2000], run_id))
    conn.commit()


def last_run(conn) -> dict | None:
    r = conn.execute("SELECT started_at, finished_at, ok, message FROM runs WHERE source = 'sectors'"
                     " AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1").fetchone()
    return dict(r) if r else None


def is_stale(conn) -> bool:
    r = last_run(conn)
    if r is None:
        return True
    started = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00"))
    return datetime.now(timezone.utc) - started >= timedelta(minutes=STALE_MINUTES)


def build(conn) -> dict:
    series: dict[str, list] = {}
    for r in conn.execute("SELECT symbol, date, adjclose FROM sector_daily ORDER BY symbol, date"):
        series.setdefault(r["symbol"], []).append([r["date"], round(r["adjclose"], 4)])
    dates = [s[-1][0] for s in series.values() if s]
    return {
        "sectors": [{"symbol": s, "name": n} for s, n in SECTORS],
        "benchmarks": [{"symbol": s, "name": n} for s, n in BENCHMARKS],
        "extras": [{"symbol": s, "name": n} for s, n in EXTRAS],
        "series": series,
        "as_of": max(dates) if dates else None,
        "last_run": last_run(conn),
    }
