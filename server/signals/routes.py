"""HTTP API for the Signals page."""
import fcntl
import json
import threading
import time
from datetime import date, datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import sectors as sector_data
from .activity import agreements as list_agreements, build as build_activity
from .flags import series_stats, series_tickers
from .regime import evaluate as evaluate_regime
from .run import SOURCES, run_source
from .store import DB_PATH, connect, load_config, load_keys

router = APIRouter(prefix="/api/signals")

SOURCE_LABELS = {"sec": "SEC filings", "trade": "Exports by country",
                 "fred": "US industry data (FRED)", "usaspending": "Federal contracts",
                 "regime": "Regime signals"}
SOURCE_ABOUT = {
    "sec": "Company filings with the US Securities and Exchange Commission: 8-K events, quarterly and annual"
           " reports, large-shareholder filings, and other companies' agreements that name your stocks.",
    "fred": "US chip and electronics industry data: factory output, capacity in use, chip producer prices, and"
            " electronics orders, shipments and inventories. Shown under Industry data.",
    "usaspending": "US government contracts awarded to your stocks, from USASpending.gov.",
    "regime": "The six regime signals: 2s10s curve, HY and IG credit spreads, Fed Treasury holdings and the Treasury"
              " General Account (FRED), ISM PMIs (ISM releases on PR Newswire) and VIX (CBOE). Shown under Regime.",
    "trade": "AI-hardware trade by country: UN Comtrade for the US, Japan Customs (e-Stat) for Japan; the official"
             " monthly releases of Taiwan and South Korea, Taiwan's export orders, and Korea's 10-day preliminary"
             " exports, read by Claude.",
}
KEY_HELP = {
    "fred": "Needs a free API key: sign up at fredaccount.stlouisfed.org, create one under API Keys, and save it in"
            " data/keys.json as fred_api_key.",
}


def _rows(sql: str, args: tuple = ()) -> list[dict]:
    with connect() as conn:
        return [dict(r) for r in conn.execute(sql, args)]


GROUPS = [
    ("trade:TW", "Taiwan: exports", "Ministry of Finance monthly release, around the 8th."),
    ("trade:TW_ORD", "Taiwan: export orders", "New orders taken by Taiwanese companies. They lead actual exports by one to"
     " three months. Ministry of Economic Affairs, around the 20th."),
    ("trade:KR", "South Korea: exports", "Trade ministry monthly release, on the 1st."),
    ("trade:KR_PRE", "South Korea: exports so far this month", "Preliminary customs figures for the 1st–10th and"
     " 1st–20th, out around the 11th and 21st."),
    ("trade:US", "United States: exports, and imports from Taiwan", "UN Comtrade, about three months behind."),
    ("trade:JP", "Japan: exports", "Japan Customs via e-Stat, about three weeks after month end; converted to US"
     " dollars at the monthly exchange rate."),
    ("US industry (FRED)", "United States: chip and electronics industry", "Federal Reserve, Census Bureau and Bureau of"
     " Labor Statistics, via FRED, about six weeks after month end."),
]


def _months_since(period: str, today: date) -> int:
    y, m = map(int, period.split("-"))
    return today.year * 12 + today.month - (y * 12 + m)


def _series_status(series_id: str, latest: str, cfg: dict, today: date) -> tuple[str, int]:
    """'on_time' when the latest figure is as recent as the source's normal delay allows, 'late' one month
    behind that, 'stale' more."""
    lags = cfg.get("trade", {}).get("lag_months", {})
    lag = max((v for k, v in lags.items() if series_id.startswith(k)), default=2)
    behind = _months_since(latest, today) - lag
    return ("on_time" if behind <= 0 else "late" if behind == 1 else "stale"), lag


def _source_status(state: str, last_ok: str | None, every_minutes: int) -> str:
    """Green within twice the collection interval (at least 6 hours), amber up to six times it (at least
    two days), red beyond that or after a failed run."""
    if state in ("error", "never") or not last_ok:
        return "red" if state == "error" else "amber"
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(last_ok.replace("Z", "+00:00"))).total_seconds() / 60
    if age <= max(2 * every_minutes, 360):
        return "green"
    return "amber" if age <= max(6 * every_minutes, 2880) else "red"


@router.get("/overview")
def overview() -> dict:
    cfg = load_config()
    sources = []
    for name in SOURCES:
        last = _rows("SELECT * FROM runs WHERE source = ? ORDER BY id DESC LIMIT 1", (name,))
        ok = _rows("SELECT finished_at FROM runs WHERE source = ? AND ok = 1 ORDER BY id DESC LIMIT 1", (name,))
        r = last[0] if last else None
        state = ("never" if r is None else "running" if r["finished_at"] is None
                 else {1: "ok", 0: "error", None: "setup"}[r["ok"]])
        every = cfg["schedule"][name]["every_minutes"]
        sources.append({
            "name": name,
            "label": SOURCE_LABELS[name],
            "state": state,
            "freshness": _source_status(state, ok[0]["finished_at"] if ok else None, every),
            "every_minutes": every,
            "last_run": r["started_at"] if r else None,
            "last_ok": ok[0]["finished_at"] if ok else None,
            "message": r["message"] if r else None,
            "about": SOURCE_ABOUT[name],
            "key_help": KEY_HELP.get(name),
        })

    hist = cfg["flags"]["history_months"]
    max_age = cfg.get("display", {}).get("max_age_months", 4)
    firms = cfg.get("trade", {}).get("firms", {})
    today = date.today()
    order = {g[0]: i for i, g in enumerate(GROUPS)}
    series = []
    with connect() as conn:
        def rank(row) -> tuple:
            # country order, then products, then destinations, then the country total
            sid = row["id"]
            return (order.get(row["grp"], 99), 2 if sid.endswith(":total") else 1 if ":to_" in sid else 0, sid)

        for s in sorted(conn.execute("SELECT * FROM series").fetchall(), key=rank):
            rows = conn.execute("SELECT period, value, note, yoy_reported FROM observations WHERE series_id = ?"
                                " ORDER BY period", (s["id"],)).fetchall()
            obs = [(r["period"], r["value"]) for r in rows]
            reported = {r["period"]: r["yoy_reported"] for r in rows if r["yoy_reported"] is not None}
            st = series_stats(obs, hist, reported)
            if not st or _months_since(st["latest"], today) > max_age:
                continue  # stale, or still backfilling: hidden until its latest month is recent
            status, lag = _series_status(s["id"], st["latest"], cfg, today)
            series.append({**dict(s), **st, "note": rows[-1]["note"], "count": len(obs),
                           "spark": [v for _, v in obs[-36:]], "tickers": series_tickers(cfg, s["id"]),
                           "firms": next((v for k, v in firms.items() if s["id"] == k or s["id"].startswith(k + ":")), None),
                           "freshness": status, "lag_months": lag})

    groups = [{"id": gid, "title": title, "note": note} for gid, title, note in GROUPS]
    return {"watchlist": cfg["watchlist"], "names": cfg.get("names", {}), "sources": sources, "series": series,
            "groups": groups}


@router.get("/regime")
def regime() -> dict:
    with connect() as conn:
        return _regime(conn)


@router.post("/regime/collect")
def collect_regime() -> dict:
    """Fetch fresh regime data now (the Reload button), then return the page data. Shares the scheduler's lock, so
    a scheduled run in progress is waited for (up to a minute) instead of run twice."""
    with open(DB_PATH.with_suffix(".lock"), "w") as lock:
        for _ in range(60):
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(1)
        else:
            raise HTTPException(409, "Another collection is still running; try again shortly")
        with connect() as conn:
            run_source(conn, "regime", load_config(), load_keys())
            return _regime(conn)


def _regime(conn) -> dict:
    run = conn.execute("SELECT finished_at, ok, message FROM runs WHERE source = 'regime' AND finished_at IS NOT NULL"
                       " ORDER BY id DESC LIMIT 1").fetchone()
    return {**evaluate_regime(conn), "last_run": dict(run) if run else None}


SECTORS_LOCK = DB_PATH.with_name("sectors.lock")


def _refresh_sectors() -> None:
    """One fetch at a time; a second caller finds the lock taken and leaves it to the first."""
    with open(SECTORS_LOCK, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        with connect() as conn:
            if sector_data.is_stale(conn):
                sector_data.run(conn)


@router.get("/sectors")
def sectors() -> dict:
    """Sector ETF and benchmark closes. Fetched here, not by a scheduler: a read finding data older than
    15 minutes starts a fetch in the background (about 25 s) and returns what is stored; the page's
    once-a-minute reload picks up the result. With nothing stored yet it waits for the fetch."""
    with connect() as conn:
        if sector_data.is_stale(conn):
            if conn.execute("SELECT 1 FROM sector_daily LIMIT 1").fetchone() is None:
                _refresh_sectors()
            else:
                threading.Thread(target=_refresh_sectors, daemon=True).start()
        return sector_data.build(conn)


@router.post("/sectors/collect")
def collect_sectors() -> dict:
    """Fetch fresh prices now (the Reload button), then return the page data."""
    with open(SECTORS_LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with connect() as conn:
            sector_data.run(conn)
            return sector_data.build(conn)


@router.get("/activity")
def activity() -> dict:
    with connect() as conn:
        return build_activity(conn, load_config())


@router.get("/series/{series_id:path}")
def series_detail(series_id: str) -> dict:
    meta = _rows("SELECT * FROM series WHERE id = ?", (series_id,))
    if not meta:
        raise HTTPException(404, "Series not found")
    return {**meta[0], "observations": _rows(
        "SELECT period, value, note, yoy_reported FROM observations WHERE series_id = ? ORDER BY period", (series_id,))}


@router.get("/agreements")
def agreements() -> list[dict]:
    with connect() as conn:
        return list_agreements(conn, load_config())


@router.get("/filings")
def filings(ticker: str | None = None, limit: int = 300) -> list[dict]:
    where, args = ("WHERE ticker = ?", (ticker,)) if ticker else ("", ())
    rows = _rows(f"SELECT accession, ticker, form, items, filed_at, report_date, description, url, insider"
                 f" FROM filings {where} ORDER BY filed_at DESC LIMIT ?", (*args, min(limit, 2000)))
    for r in rows:
        r["insider"] = json.loads(r["insider"]) if r["insider"] else None
    return rows


@router.get("/awards")
def awards(ticker: str | None = None, limit: int = 300) -> list[dict]:
    where, args = ("WHERE ticker = ?", (ticker,)) if ticker else ("", ())
    return _rows(f"SELECT key, ticker, recipient, award_id, modification, action_date, amount, agency, description,"
                 f" url FROM awards {where} ORDER BY action_date DESC, ABS(amount) DESC LIMIT ?",
                 (*args, min(limit, 2000)))


class FlagUpdate(BaseModel):
    seen: bool


@router.patch("/flags/{flag_id}")
def update_flag(flag_id: int, body: FlagUpdate) -> dict:
    with connect() as conn:
        cur = conn.execute("UPDATE flags SET seen = ? WHERE id = ?", (int(body.seen), flag_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "Flag not found")
    return {"id": flag_id, "seen": body.seen}


@router.post("/flags/seen")
def mark_all_seen() -> dict:
    with connect() as conn:
        n = conn.execute("UPDATE flags SET seen = 1 WHERE seen = 0").rowcount
    return {"updated": n}
