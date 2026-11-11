"""collect the regime page's readings.

    python3 -m server.signals.run            # now
    python3 -m server.signals.run --due      # only inside its schedule window (for launchd)
"""
import argparse
import fcntl
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import regime
from .store import DB_PATH, MissingKey, connect, load_config, load_keys, now

SOURCES = {"regime": regime}


def is_due(conn, name: str, rule: dict, at: datetime) -> bool:
    local = at.astimezone(ZoneInfo(rule["tz"]))
    if "weekdays" in rule and local.weekday() not in rule["weekdays"]:
        return False
    if "days" in rule and not rule["days"][0] <= local.day <= rule["days"][1]:
        return False
    if not rule["hours"][0] <= local.hour < rule["hours"][1]:
        return False
    last = conn.execute("SELECT MAX(started_at) FROM runs WHERE source = ?", (name,)).fetchone()[0]
    if last is None:
        return True
    gap = at - datetime.fromisoformat(last.replace("Z", "+00:00"))
    return gap >= timedelta(minutes=rule["every_minutes"]) - timedelta(minutes=1)


def run_source(conn, name: str, cfg: dict, keys: dict) -> str:
    run_id = conn.execute("INSERT INTO runs (source, started_at) VALUES (?, ?)", (name, now())).lastrowid
    conn.commit()
    ok, rows, msg = 1, 0, ""
    try:
        res = SOURCES[name].collect(conn, cfg, keys)
        rows = res["rows"]
        # a changed reading is reported first, then any part that failed
        raised = len(res["changes"])
        res["errors"] = res["changes"] + res["errors"]
        msg = f"{rows} new, {raised} changed"
        if res.get("errors"):
            msg += "; " + "; ".join(res["errors"][:5])
    except MissingKey as e:
        ok, msg = None, str(e)
    except Exception as e:  # recorded on the run so the dashboard shows it
        ok, msg = 0, f"{type(e).__name__}: {e}"
    conn.execute("UPDATE runs SET finished_at = ?, ok = ?, rows = ?, message = ? WHERE id = ?",
                 (now(), ok, rows, msg[:2000], run_id))
    conn.commit()
    return msg


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("sources", nargs="*", metavar="source", help=f"one or more of: {', '.join(SOURCES)}")
    p.add_argument("--due", action="store_true", help="run only sources whose schedule window is open")
    args = p.parse_args()
    if unknown := [s for s in args.sources if s not in SOURCES]:
        p.error(f"unknown source {', '.join(unknown)}; choose from {', '.join(SOURCES)}")

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    lock = open(DB_PATH.with_suffix(".lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another collection run is in progress")
        return 0

    cfg, keys = load_config(), load_keys()
    conn = connect()
    names = args.sources or list(SOURCES)
    if args.due:
        at = datetime.now(timezone.utc)
        names = [n for n in names if is_due(conn, n, cfg["schedule"][n], at)]
    for n in names:
        print(f"{n}: {run_source(conn, n, cfg, keys)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
