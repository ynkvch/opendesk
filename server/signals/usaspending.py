"""US federal contract actions (new awards, modifications, options exercised) from USASpending.gov.

The recipient search is fuzzy ("INTEL" also matches "AIR SPACE INTELLIGENCE"), so results are kept
only when the recipient name starts with one of the configured names. Defense contracts appear
with a reporting delay of up to 90 days, so each run re-reads a long window and skips duplicates.
"""
from datetime import date, timedelta

from .http import fetch_json
from .store import now

URL = "https://api.usaspending.gov/api/v2/search/spending_by_transaction/"
FIELDS = ["Award ID", "Recipient Name", "Action Date", "Transaction Amount", "Awarding Agency",
          "Transaction Description", "Mod", "generated_internal_id"]


def collect(conn, cfg: dict, keys: dict) -> dict:
    ucfg = cfg["usaspending"]
    end = date.today()
    start = end - timedelta(days=ucfg["lookback_days"])
    new: list[str] = []
    for ticker, names in ucfg["recipients"].items():
        prefixes = tuple(n.upper() for n in names)
        for page in range(1, ucfg["max_pages"] + 1):
            res = fetch_json(URL, data={
                "filters": {
                    "recipient_search_text": names,
                    "award_type_codes": ["A", "B", "C", "D"],
                    "time_period": [{"start_date": start.isoformat(), "end_date": end.isoformat()}],
                },
                "fields": FIELDS, "limit": 100, "page": page, "sort": "Action Date", "order": "desc",
            })
            for r in res.get("results", []):
                recipient = (r.get("Recipient Name") or "").upper()
                if not recipient.startswith(prefixes) or r.get("Transaction Amount") is None:
                    continue
                gid = r.get("generated_internal_id") or r["Award ID"]
                key = f"{gid}|{r.get('Mod') or ''}|{r['Action Date']}|{r['Transaction Amount']}"
                cur = conn.execute(
                    "INSERT OR IGNORE INTO awards (key, ticker, recipient, award_id, modification, action_date, amount,"
                    " agency, description, url, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (key, ticker, r["Recipient Name"], r["Award ID"], r.get("Mod"), r["Action Date"],
                     float(r["Transaction Amount"]), r.get("Awarding Agency"),
                     (r.get("Transaction Description") or "").strip(),
                     f"https://www.usaspending.gov/award/{gid}", now()))
                if cur.rowcount:
                    new.append(key)
            if not res.get("page_metadata", {}).get("hasNext"):
                break
        conn.commit()
    return {"rows": len(new), "awards": new, "errors": []}
