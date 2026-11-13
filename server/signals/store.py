"""sqlite store for the regime page's readings, the sector prices and the collection runs.

kept in its own file (data/signals.db) so the trade journal stays a clean factual record.
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

-- Settings made on the page, such as the regime score formula, kept as JSON by key.
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
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
    """a source can't run until its key is added to data/keys.json."""


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    return conn


def load_config() -> dict:
    return json.loads(CONFIG_PATH.read_text())


def load_keys() -> dict:
    """the fred api key. the environment variable FRED_API_KEY wins over data/keys.json."""
    keys = json.loads(KEYS_PATH.read_text()) if KEYS_PATH.exists() else {}
    if os.environ.get("FRED_API_KEY"):
        keys["fred_api_key"] = os.environ["FRED_API_KEY"]
    return keys
