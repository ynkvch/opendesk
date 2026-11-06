"""US industry data from FRED (Federal Reserve Bank of St. Louis).

With a free API key (data/keys.json -> fred_api_key) this uses the official API. Without one it
falls back to FRED's public CSV download, which works but gets bot-blocked under repeated use.
"""
import csv
import io
import json
from urllib.parse import urlencode

from .http import FetchError, fetch
from .store import MissingKey, upsert_obs, upsert_series

GROUP = "US industry (FRED)"
KEY_HELP = "Add fred_api_key to data/keys.json (free key: fredaccount.stlouisfed.org → API Keys)"


def _observations(series_id: str, start: str, key: str | None) -> list[tuple[str, float]]:
    if key:
        q = urlencode({"series_id": series_id, "api_key": key, "file_type": "json", "observation_start": start})
        data = json.loads(fetch(f"https://api.stlouisfed.org/fred/series/observations?{q}"))
        rows = [(o["date"], o["value"]) for o in data["observations"]]
    else:
        try:
            body = fetch(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={start}",
                         timeout=30, retries=1)
        except FetchError as e:
            raise MissingKey(f"{KEY_HELP} (keyless download failed: {e})") from e
        if body.lstrip()[:1] == b"<":
            raise MissingKey(f"{KEY_HELP} (keyless download was bot-blocked)")
        reader = csv.reader(io.StringIO(body.decode()))
        next(reader)
        rows = [(r[0], r[1]) for r in reader if len(r) >= 2]
    out = []
    for d, v in rows:
        try:
            out.append((d[:7], float(v)))
        except ValueError:
            continue  # '.' marks a missing value
    return out


def collect(conn, cfg: dict, keys: dict) -> dict:
    fcfg = cfg["fred"]
    key = keys.get("fred_api_key") or None
    new = 0
    errors = []
    for s in fcfg["series"]:
        sid = f"fred:{s['id']}"
        upsert_series(conn, sid, "fred", GROUP, s["title"], s["unit"], f"https://fred.stlouisfed.org/series/{s['id']}",
                      about=s["about"], publisher=s["source"])
        try:
            for period, value in _observations(s["id"], fcfg["start"], key):
                new += upsert_obs(conn, sid, period, value)
        except FetchError as e:
            errors.append(f"{s['id']}: {e}")
        conn.commit()
    return {"rows": new, "errors": errors}
