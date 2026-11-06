"""Scheduled journal updates. launchd wakes this every 15 minutes; it exits at once unless something is due.

  - Flex (no TWS needed): once a day from 07:00 London time, the last 7 days;
    the last 90 days instead if the previous 90-day run is a week old, as a catch-up.
  - TWS: every run from 04:00 to 20:00 New York, the full pre- and post-market (outside the options session it saves
    IBKR's model P&L),
    only if TWS is open with the API on port 7496. Otherwise skipped quietly.

Run by hand to see what it would do:
    python3 -m server.journal_job
"""
import json
import socket
import sys
import traceback
from datetime import datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

DATA = Path(__file__).resolve().parent.parent / "data"
STATE = DATA / "journal_job.json"
LONDON = ZoneInfo("Europe/London")
NY = ZoneInfo("America/New_York")
TWS_PORT = 7496


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def tws_open() -> bool:
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", TWS_PORT)) == 0


def flex_configured() -> bool:
    try:
        keys = json.loads((DATA / "keys.json").read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return False
    return bool(keys.get("ibkr_flex_token") and keys.get("ibkr_flex_query_id"))


def log(msg: str) -> None:
    print(f"{datetime.now(LONDON):%Y-%m-%d %H:%M} {msg}", flush=True)


def main() -> None:
    state = load_state()
    now_ldn = datetime.now(LONDON)
    now_ny = datetime.now(NY)

    # Flex, once a day
    today = now_ldn.date().isoformat()
    if flex_configured() and state.get("flex_day") != today and now_ldn.time() >= time(7, 0):
        last_long = state.get("flex_90_day")
        days = 90 if not last_long or (now_ldn.date() - datetime.fromisoformat(last_long).date()) >= timedelta(days=7) else 7
        try:
            from .flex import download, import_report
            stats = import_report(download(days))
            log(f"Flex {days}d: " + ", ".join(f"{k} {v}" for k, v in stats.items()))
            state["flex_day"] = today
            if days == 90:
                state["flex_90_day"] = today
        except SystemExit as e:
            log(f"Flex failed: {e}")
        except Exception:
            log("Flex failed:\n" + traceback.format_exc())

    # TWS, from the start of US pre-market to the end of post-market (IBKR's model P&L outside the options session)
    session = now_ny.weekday() < 5 and time(4, 0) <= now_ny.time() <= time(20, 0)
    if session and tws_open():
        try:
            sys.argv = ["sync_tws"]
            from .sync_tws import main as tws_sync
            tws_sync()
            state["tws_last"] = now_ldn.isoformat(timespec="minutes")
        except SystemExit as e:
            log(f"TWS sync failed: {e}")
        except Exception:
            log("TWS sync failed:\n" + traceback.format_exc())

    STATE.write_text(json.dumps(state, indent=2))


if __name__ == "__main__":
    main()
