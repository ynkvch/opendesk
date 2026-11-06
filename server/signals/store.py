"""SQLite store for collected releases, filings, contracts and the flags raised from them.

Kept in its own file (data/signals.db) so the trade journal stays a clean factual record.
"""
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH = ROOT / "data" / "signals.db"
CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
KEYS_PATH = ROOT / "data" / "keys.json"

SCHEMA = """
CREATE TABLE IF NOT EXISTS series (
    id          TEXT PRIMARY KEY,        -- e.g. 'trade:tw_rel:total', 'trade:jp_x:8486', 'fred:IPG3344S'
    source      TEXT NOT NULL,           -- 'trade' | 'fred'
    grp         TEXT NOT NULL,           -- display group
    name        TEXT NOT NULL,
    unit        TEXT NOT NULL,           -- 'twd_k' | 'usd' | 'usd_m' | 'index' | 'pct'
    url         TEXT,
    about       TEXT,                    -- plain-English description of what the numbers are
    publisher   TEXT                     -- who publishes them
);

-- Material agreements other companies filed with the SEC that name a covered company.
CREATE TABLE IF NOT EXISTS agreements (
    key         TEXT PRIMARY KEY,        -- accession + mentioned ticker
    ticker      TEXT NOT NULL,           -- the covered company that is mentioned
    filer       TEXT NOT NULL,
    filer_cik   INTEGER NOT NULL,
    form        TEXT NOT NULL,
    items       TEXT NOT NULL,
    filed       TEXT NOT NULL,           -- YYYY-MM-DD
    url         TEXT NOT NULL,
    excerpt     TEXT,                    -- the sentences that mention the company
    doc_type    TEXT,                    -- the matching document: '8-K', 'EX-10.1' (a contract), 'EX-99.1' (press release)
    relation    TEXT,                    -- 'party' (named as a party to the deal) | 'mention'
    amount      REAL,                    -- largest USD amount in the sentence about price or size
    amount_text TEXT,                    -- that sentence, so the number can be checked
    first_seen  TEXT NOT NULL
);

-- Claude's reading of each agreement: who it is with and for how much.
CREATE TABLE IF NOT EXISTS deal_ai (
    key         TEXT PRIMARY KEY,        -- agreement key (accession, or accession|ticker)
    text_hash   TEXT NOT NULL,           -- hash of the text Claude read; a change triggers a re-check
    is_party    INTEGER NOT NULL,
    counterparties TEXT NOT NULL,        -- JSON list
    amount_usd  REAL,
    amount_quote TEXT,
    deal_type   TEXT,
    summary     TEXT,
    model       TEXT,
    checked_at  TEXT NOT NULL
);

-- Official trade releases already read by Claude, so each is read once.
CREATE TABLE IF NOT EXISTS releases_read (
    url         TEXT PRIMARY KEY,
    country     TEXT NOT NULL,
    period      TEXT,                    -- YYYY-MM the release covers
    ok          INTEGER NOT NULL,        -- 0 when it wasn't a monthly export release
    checked_at  TEXT NOT NULL
);

-- Comtrade months already asked for, so empty months aren't re-requested on every run.
CREATE TABLE IF NOT EXISTS comtrade_checked (
    flow        TEXT NOT NULL,
    period      TEXT NOT NULL,
    rows        INTEGER NOT NULL,
    checked_at  TEXT NOT NULL,
    PRIMARY KEY (flow, period)
);


CREATE TABLE IF NOT EXISTS observations (
    series_id   TEXT NOT NULL REFERENCES series(id),
    period      TEXT NOT NULL,           -- 'YYYY-MM'
    value       REAL NOT NULL,
    note        TEXT,                    -- e.g. which days a preliminary figure covers
    yoy_reported REAL,                   -- year-over-year change in percent as the source states it
    first_seen  TEXT NOT NULL,           -- when this period first appeared (ISO, UTC)
    updated_at  TEXT NOT NULL,           -- last time the value changed (revisions)
    PRIMARY KEY (series_id, period)
);

CREATE TABLE IF NOT EXISTS filings (
    accession   TEXT PRIMARY KEY,
    ticker      TEXT NOT NULL,
    cik         INTEGER NOT NULL,
    form        TEXT NOT NULL,
    items       TEXT NOT NULL DEFAULT '', -- 8-K item codes, comma separated
    filed_at    TEXT NOT NULL,           -- SEC acceptance time (ISO, UTC)
    report_date TEXT,
    description TEXT,
    url         TEXT NOT NULL,
    insider     TEXT,                    -- Form 4: JSON summary of the reporting owner's trades
    excerpt     TEXT,                    -- 8-K: JSON {item: opening text of that item}
    first_seen  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS filings_ticker ON filings(ticker, filed_at);

CREATE TABLE IF NOT EXISTS awards (
    key         TEXT PRIMARY KEY,        -- award + modification + action date
    ticker      TEXT NOT NULL,
    recipient   TEXT NOT NULL,
    award_id    TEXT NOT NULL,
    modification TEXT,
    action_date TEXT NOT NULL,
    amount      REAL NOT NULL,           -- this transaction's obligation, USD (can be negative)
    agency      TEXT,
    description TEXT,
    url         TEXT NOT NULL,
    first_seen  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS awards_ticker ON awards(ticker, action_date);

CREATE TABLE IF NOT EXISTS flags (
    id          INTEGER PRIMARY KEY,
    ref         TEXT NOT NULL UNIQUE,    -- what raised it; one flag per ref
    kind        TEXT NOT NULL,           -- 'series' | 'filing' | 'insider' | 'award'
    severity    TEXT NOT NULL,           -- 'info' | 'notable' | 'major'
    direction   INTEGER NOT NULL DEFAULT 0, -- +1 / -1 for a rise / fall, 0 when it has no sign
    tickers     TEXT NOT NULL DEFAULT '', -- comma separated
    title       TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '',
    url         TEXT,
    event_at    TEXT NOT NULL,           -- when the underlying event happened / was released
    created_at  TEXT NOT NULL,
    seen        INTEGER NOT NULL DEFAULT 0
);

-- Reported revenue and net income from SEC XBRL data, by quarter (or by year for foreign filers).
CREATE TABLE IF NOT EXISTS financials (
    ticker      TEXT NOT NULL,
    metric      TEXT NOT NULL,           -- 'revenue' | 'net_income'
    period      TEXT NOT NULL,           -- 'Q' | 'FY'
    start       TEXT NOT NULL,
    end         TEXT NOT NULL,
    value       REAL NOT NULL,
    currency    TEXT NOT NULL,
    derived     INTEGER NOT NULL DEFAULT 0, -- 1 = fourth quarter computed as year minus three quarters
    form        TEXT,
    filed       TEXT,
    PRIMARY KEY (ticker, metric, end)
);

-- Regime signals: daily (FRED, CBOE), weekly (Fed balance sheet) and monthly (ISM) values by date.
CREATE TABLE IF NOT EXISTS regime_obs (
    series      TEXT NOT NULL,           -- FRED id, 'VIX', 'ISM_MFG', 'ISM_SVC'
    date        TEXT NOT NULL,           -- YYYY-MM-DD (ISM: first of the month covered)
    value       REAL NOT NULL,
    first_seen  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (series, date)
);

-- Last reading of each regime signal, so a change can be noticed and notified once.
CREATE TABLE IF NOT EXISTS regime_state (
    signal      TEXT PRIMARY KEY,
    state       TEXT NOT NULL,
    changed_at  TEXT NOT NULL
);

-- Sector performance: daily closes of the sector SPDR ETFs and their benchmarks (Yahoo Finance).
-- adjclose is dividend- and split-adjusted, so returns from it are total returns.
CREATE TABLE IF NOT EXISTS sector_daily (
    symbol      TEXT NOT NULL,
    date        TEXT NOT NULL,           -- YYYY-MM-DD, exchange time; the latest row can be today's live price
    close       REAL NOT NULL,
    adjclose    REAL NOT NULL,
    PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY,
    source      TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    ok          INTEGER,
    rows        INTEGER,
    message     TEXT
);
CREATE INDEX IF NOT EXISTS runs_source ON runs(source, started_at);
"""


class MissingKey(Exception):
    """A source can't run until its key is added to data/keys.json."""


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    conn.execute("DROP TABLE IF EXISTS translations")
    if "yoy_reported" not in {r[1] for r in conn.execute("PRAGMA table_info(observations)")}:
        conn.execute("ALTER TABLE observations ADD COLUMN yoy_reported REAL")
    if "excerpt" not in {r[1] for r in conn.execute("PRAGMA table_info(filings)")}:
        conn.execute("ALTER TABLE filings ADD COLUMN excerpt TEXT")
    agreement_cols = {r[1] for r in conn.execute("PRAGMA table_info(agreements)")}
    for col, kind in (("doc_type", "TEXT"), ("relation", "TEXT"), ("amount", "REAL"), ("amount_text", "TEXT")):
        if col not in agreement_cols:
            conn.execute(f"ALTER TABLE agreements ADD COLUMN {col} {kind}")
    series_cols = {r[1] for r in conn.execute("PRAGMA table_info(series)")}
    for col in ("about", "publisher"):
        if col not in series_cols:
            conn.execute(f"ALTER TABLE series ADD COLUMN {col} TEXT")
    return conn


def load_config() -> dict:
    return json.loads(CONFIG_PATH.read_text())


def load_keys() -> dict:
    """API keys and the SEC contact string. Environment variables win over data/keys.json."""
    keys = json.loads(KEYS_PATH.read_text()) if KEYS_PATH.exists() else {}
    for name in ("sec_user_agent", "fred_api_key", "comtrade_key", "census_key", "estat_app_id"):
        if os.environ.get(name.upper()):
            keys[name] = os.environ[name.upper()]
    return keys


def upsert_series(conn: sqlite3.Connection, id: str, source: str, grp: str, name: str, unit: str,
                  url: str | None = None, about: str | None = None, publisher: str | None = None) -> None:
    conn.execute(
        "INSERT INTO series (id, source, grp, name, unit, url, about, publisher) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(id) DO UPDATE SET source = excluded.source, grp = excluded.grp, name = excluded.name,"
        " unit = excluded.unit, url = excluded.url, about = excluded.about, publisher = excluded.publisher",
        (id, source, grp, name, unit, url, about, publisher))


def upsert_obs(conn: sqlite3.Connection, series_id: str, period: str, value: float,
               note: str | None = None, yoy: float | None = None) -> bool:
    """Insert or revise one observation. Returns True when the period is new."""
    t = now()
    row = conn.execute("SELECT value, note, yoy_reported FROM observations WHERE series_id = ? AND period = ?",
                       (series_id, period)).fetchone()
    if row is None:
        conn.execute("INSERT INTO observations (series_id, period, value, note, first_seen, updated_at, yoy_reported)"
                     " VALUES (?, ?, ?, ?, ?, ?, ?)", (series_id, period, value, note, t, t, yoy))
        return True
    if abs(row["value"] - value) > 1e-9 or (note and note != row["note"]) or (yoy is not None and yoy != row["yoy_reported"]):
        conn.execute("UPDATE observations SET value = ?, note = COALESCE(?, note), yoy_reported = COALESCE(?, yoy_reported),"
                     " updated_at = ? WHERE series_id = ? AND period = ?", (value, note, yoy, t, series_id, period))
    return False


def add_flag(conn: sqlite3.Connection, *, ref: str, kind: str, severity: str, title: str, event_at: str,
             tickers: list[str] | None = None, detail: str = "", url: str | None = None,
             direction: int = 0) -> bool:
    cur = conn.execute(
        "INSERT OR IGNORE INTO flags (ref, kind, severity, direction, tickers, title, detail, url, event_at, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (ref, kind, severity, direction, ",".join(tickers or []), title, detail, url, event_at, now()))
    return cur.rowcount > 0
