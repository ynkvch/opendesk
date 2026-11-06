"""SQLite schema and connection helper for the trade journal."""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "journal.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    id               INTEGER PRIMARY KEY,
    underlying       TEXT NOT NULL,
    strategy         TEXT NOT NULL,          -- e.g. 'Long call', 'Put debit spread'
    bias             TEXT NOT NULL,          -- 'bullish' | 'bearish' | 'neutral' | 'volatility'
    status           TEXT NOT NULL,          -- 'open' | 'closed'
    quantity         INTEGER NOT NULL,       -- number of spreads / contracts
    opened_at        TEXT NOT NULL,          -- ISO 8601, UTC
    closed_at        TEXT,
    entry_price      REAL NOT NULL,          -- net debit per unit, per share
    exit_price       REAL,
    max_risk         REAL NOT NULL,          -- USD at entry
    realized_pnl     REAL,                   -- USD, net of commissions
    commissions      REAL NOT NULL DEFAULT 0,
    mae              REAL NOT NULL DEFAULT 0, -- max adverse excursion, USD (<= 0)
    mfe              REAL NOT NULL DEFAULT 0, -- max favourable excursion, USD (>= 0)
    und_entry        REAL NOT NULL,
    und_exit         REAL,
    und_high         REAL NOT NULL,          -- underlying high while in trade
    und_low          REAL NOT NULL,
    pos_high         REAL NOT NULL,          -- position mark high, per share
    pos_low          REAL NOT NULL,
    iv_entry         REAL NOT NULL,          -- IV of the main leg at entry (decimal)
    iv_exit          REAL,
    und_last         REAL,                   -- latest underlying price (live for open trades)
    iv_last          REAL,                   -- latest IV of the main leg
    last_update      TEXT,                   -- ISO time of und_last / iv_last
    iv_rank_entry    REAL,                   -- 0-100
    hv20_entry       REAL,                   -- 20-day realized vol of underlying (decimal)
    dte_entry        INTEGER NOT NULL,
    delta_entry REAL, gamma_entry REAL, theta_entry REAL, vega_entry REAL,  -- position Greeks, USD terms
    delta_exit  REAL, gamma_exit  REAL, theta_exit  REAL, vega_exit  REAL,
    thesis           TEXT NOT NULL DEFAULT '',
    post_mortem      TEXT NOT NULL DEFAULT '',
    source           TEXT NOT NULL DEFAULT 'demo',  -- 'demo' | 'tws' | 'flex'
    asset            TEXT NOT NULL DEFAULT 'OPT',   -- 'OPT' | 'STK'
    multiplier       REAL NOT NULL DEFAULT 100,     -- 100 for options, 1 for shares
    open_estimated   INTEGER NOT NULL DEFAULT 0     -- 1 = bought before the earliest statement; date is a bound
);

CREATE TABLE IF NOT EXISTS legs (
    id          INTEGER PRIMARY KEY,
    trade_id    INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    side        TEXT NOT NULL,               -- 'BUY' | 'SELL'
    ratio       INTEGER NOT NULL DEFAULT 1,
    right_      TEXT NOT NULL,               -- 'C' | 'P' | 'S' (shares)
    strike      REAL NOT NULL,
    expiry      TEXT NOT NULL,               -- YYYY-MM-DD, '' for shares
    entry_price REAL NOT NULL,
    exit_price  REAL,
    iv_entry    REAL NOT NULL,
    iv_exit     REAL,
    delta_entry REAL NOT NULL,
    delta_exit  REAL,
    conid       INTEGER                      -- IBKR contract id
);

CREATE TABLE IF NOT EXISTS fills (
    id          INTEGER PRIMARY KEY,
    trade_id    INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    exec_id     TEXT NOT NULL UNIQUE,
    time        TEXT NOT NULL,
    action      TEXT NOT NULL,               -- 'OPEN' | 'CLOSE'
    side        TEXT NOT NULL,               -- 'BOT' | 'SLD'
    description TEXT NOT NULL,
    quantity    INTEGER NOT NULL,
    price       REAL NOT NULL,
    commission  REAL NOT NULL
);

-- Position mark path while the trade is open; drives the MAE/MFE chart.
CREATE TABLE IF NOT EXISTS marks (
    trade_id    INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    time        TEXT NOT NULL,
    underlying  REAL NOT NULL,
    pnl         REAL NOT NULL,
    PRIMARY KEY (trade_id, time)
);

-- Closing option midpoint and underlying per session while the trade is open; drives the theta chart.
-- Today's row holds the latest hourly bar until the session's last sync replaces it with the close.
CREATE TABLE IF NOT EXISTS option_daily (
    trade_id    INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,               -- YYYY-MM-DD, New York session date
    underlying  REAL NOT NULL,
    option      REAL NOT NULL,               -- per share
    PRIMARY KEY (trade_id, date)
);

-- Daily closes of comparison indices (SPY), from IBKR historical data.
CREATE TABLE IF NOT EXISTS benchmark_daily (
    symbol  TEXT NOT NULL,
    date    TEXT NOT NULL,
    close   REAL NOT NULL,
    PRIMARY KEY (symbol, date)
);

-- Every IBKR trade from Flex, all asset classes (options, stock, currency conversions).
CREATE TABLE IF NOT EXISTS ib_trades (
    trade_id     TEXT PRIMARY KEY,           -- IBKR tradeID
    exec_id      TEXT,
    time         TEXT NOT NULL,              -- ISO, UTC
    trade_date   TEXT NOT NULL,              -- YYYY-MM-DD
    symbol       TEXT NOT NULL,
    underlying   TEXT,
    asset        TEXT NOT NULL,              -- OPT | STK | CASH | ...
    put_call     TEXT,
    strike       REAL,
    expiry       TEXT,
    side         TEXT NOT NULL,              -- BUY | SELL
    open_close   TEXT,                       -- O | C
    quantity     REAL NOT NULL,
    price        REAL NOT NULL,
    commission   REAL NOT NULL,              -- negative = paid
    net_cash     REAL,
    realized     REAL,
    conid        INTEGER,
    multiplier   REAL
);

-- Fees, interest, deposits and withdrawals from Flex Cash Transactions.
CREATE TABLE IF NOT EXISTS cash_transactions (
    transaction_id TEXT PRIMARY KEY,
    date           TEXT NOT NULL,
    type           TEXT NOT NULL,
    description    TEXT NOT NULL,
    amount         REAL NOT NULL,            -- in its own currency
    currency       TEXT NOT NULL,
    amount_base    REAL NOT NULL             -- in USD
);

-- Journal settings, e.g. journal_start: data before this moment is kept but not shown.
CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
    source   TEXT NOT NULL,                  -- 'flex' | 'tws'
    time     TEXT NOT NULL,
    detail   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_daily (
    date            TEXT PRIMARY KEY,        -- YYYY-MM-DD
    net_liquidation REAL NOT NULL,
    realized_pnl    REAL NOT NULL,
    unrealized_pnl  REAL NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def journal_start(conn: sqlite3.Connection) -> str:
    """ISO time the journal starts; imports skip anything earlier. '' means no limit."""
    row = conn.execute("SELECT value FROM settings WHERE key = 'journal_start'").fetchone()
    return row["value"] if row else ""


# columns added after the first release; ALTER them into databases created earlier
_ADDED = {
    "trades": [("asset", "TEXT NOT NULL DEFAULT 'OPT'"), ("multiplier", "REAL NOT NULL DEFAULT 100"),
               ("open_estimated", "INTEGER NOT NULL DEFAULT 0"), ("und_last", "REAL"), ("iv_last", "REAL"),
               ("last_update", "TEXT"),
               # IBKR's own model valuation of an open position, taken outside the options session
               ("model_mark", "REAL"), ("model_pnl", "REAL"), ("model_und", "REAL"), ("model_at", "TEXT")],
    "legs": [("conid", "INTEGER")],
}


def _migrate(conn: sqlite3.Connection) -> None:
    for table, cols in _ADDED.items():
        have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in cols:
            if name not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
