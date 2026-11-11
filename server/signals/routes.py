"""http api for the regime page and its sector tab."""
import fcntl
import threading
import time

from fastapi import APIRouter, HTTPException

from . import sectors as sector_data
from .regime import evaluate as evaluate_regime
from .run import run_source
from .store import DB_PATH, connect, load_config, load_keys

router = APIRouter(prefix="/api/signals")


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
