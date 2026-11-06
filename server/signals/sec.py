"""SEC EDGAR filings for the watchlist, their 8-K text, reported financials, and other companies' agreements
that name them.

Uses the official JSON endpoints on data.sec.gov. SEC asks every client to send a
User-Agent with a name and contact email (data/keys.json -> sec_user_agent).
"""
import html
import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlencode

from .http import FetchError, fetch, fetch_json
from .extract import contract_doc, is_party, stated_amount
from .store import ROOT, MissingKey, now

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
TICKERS_CACHE = ROOT / "data" / "company_tickers.json"

# Form 8-K item numbers, as defined by the SEC.
ITEM_LABELS = {
    "1.01": "Material agreement", "1.02": "Agreement terminated", "1.03": "Bankruptcy",
    "1.04": "Mine safety", "1.05": "Cybersecurity incident", "2.01": "Acquisition or disposal",
    "2.02": "Results of operations", "2.03": "New debt obligation", "2.04": "Debt acceleration",
    "2.05": "Exit or restructuring costs", "2.06": "Material impairment", "3.01": "Delisting notice",
    "3.02": "Unregistered share sale", "3.03": "Shareholder rights change", "4.01": "Auditor change",
    "4.02": "Prior financials unreliable", "5.01": "Change in control", "5.02": "Executive or director change",
    "5.03": "Bylaws or fiscal year change", "5.05": "Code of ethics change", "5.07": "Shareholder vote results",
    "7.01": "Reg FD disclosure", "8.01": "Other events", "9.01": "Exhibits",
}


def user_agent(keys: dict) -> str:
    ua = (keys.get("sec_user_agent") or "").strip()
    if "@" not in ua:
        raise MissingKey("Set sec_user_agent in data/keys.json to 'Your Name your@email' (SEC requirement)")
    return ua


def legal_names() -> dict[str, str]:
    """Ticker -> registered company name, from the cached SEC ticker list."""
    if not TICKERS_CACHE.exists():
        return {}
    return {v["ticker"]: v["title"] for v in json.loads(TICKERS_CACHE.read_text()).values()}


def cik_map(ua: str) -> dict[str, int]:
    fresh = TICKERS_CACHE.exists() and time.time() - TICKERS_CACHE.stat().st_mtime < 7 * 86400
    if not fresh:
        TICKERS_CACHE.write_bytes(fetch(TICKERS_URL, ua=ua))
    data = json.loads(TICKERS_CACHE.read_text())
    return {v["ticker"]: int(v["cik_str"]) for v in data.values()}


def _iso(accepted: str) -> str:
    # '2026-09-30T20:02:22.000Z' -> '2026-09-30T20:02:22Z'
    return accepted.split(".")[0].rstrip("Z") + "Z"


# Official 8-K item titles, stripped from the start of an extracted section.
ITEM_TITLES = {
    "1.01": "Entry into a Material Definitive Agreement", "1.02": "Termination of a Material Definitive Agreement",
    "1.05": "Material Cybersecurity Incidents", "2.01": "Completion of Acquisition or Disposition of Assets",
    "2.02": "Results of Operations and Financial Condition",
    "2.03": "Creation of a Direct Financial Obligation or an Obligation under an Off-Balance Sheet Arrangement"
            " of a Registrant",
    "2.05": "Costs Associated with Exit or Disposal Activities", "2.06": "Material Impairments",
    "3.01": "Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard; Transfer of Listing",
    "3.02": "Unregistered Sales of Equity Securities",
    "4.02": "Non-Reliance on Previously Issued Financial Statements or a Related Audit Report or Completed"
            " Interim Review",
    "5.02": "Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers;"
            " Compensatory Arrangements of Certain Officers",
    "5.03": "Amendments to Articles of Incorporation or Bylaws; Change in Fiscal Year",
    "5.07": "Submission of Matters to a Vote of Security Holders", "7.01": "Regulation FD Disclosure",
    "8.01": "Other Events",
}
ITEM_RE = re.compile(r"\bItem\s*(\d\.\d{2})\b\.?", re.I)


def html_text(raw: bytes) -> str:
    s = raw.decode("utf-8", errors="replace")
    s = re.sub(r"(?is)<ix:header>.*?</ix:header>|<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|li|h\d)>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"[ \t ]+", " ", s)


AGREEMENT_ITEMS = ("1.01", "1.02", "2.01")


def item_sections(text: str, items: list[str], limit: int = 900, long: int = 2500) -> dict[str, str]:
    """The opening text of each requested 8-K item, cut at a sentence end. Agreement items keep more,
    so the parties and the amount are in it."""
    marks = [(m.group(1), m.start(), m.end()) for m in ITEM_RE.finditer(text)]
    sig = re.search(r"\bSIGNATURES?\b", text)
    out = {}
    for code in items:
        best = ""
        for i, (c, _, end) in enumerate(marks):
            if c != code:
                continue
            stop = marks[i + 1][1] if i + 1 < len(marks) else (sig.start() if sig and sig.start() > end else len(text))
            seg = re.sub(r"\s+", " ", text[end:stop]).strip(" .:-—")
            title = ITEM_TITLES.get(code, "")
            if title and seg.lower().startswith(title.lower()[:24]):
                seg = seg[len(title):].lstrip(" .:-—")
            if len(seg) > len(best):
                best = seg
        if best:
            cap = long if code in AGREEMENT_ITEMS else limit
            if len(best) > cap:
                cut = best.rfind(". ", 0, cap)
                best = best[: cut + 1] if cut > cap // 3 else best[:cap].rstrip() + "…"
            out[code] = best
    return out


def enrich(conn, ua: str, scfg: dict, errors: list[str]) -> int:
    """Fill in the opening text of each 8-K item for filings that don't have it yet."""
    since = (datetime.now(timezone.utc) - timedelta(days=scfg["history_days"])).strftime("%Y-%m-%dT%H:%M:%SZ")
    todo = conn.execute(
        "SELECT accession, ticker, form, items, url FROM filings WHERE filed_at >= ?"
        " AND form IN ('8-K', '8-K/A') AND excerpt IS NULL ORDER BY filed_at DESC LIMIT ?",
        (since, scfg["enrich_max_fetches"])).fetchall()
    done = 0
    for f in todo:
        items = [i for i in f["items"].split(",") if i and i != "9.01"]
        try:
            text = item_sections(html_text(fetch(f["url"], ua=ua)), items)
        except FetchError as e:
            errors.append(f"{f['ticker']} {f['form']} {f['accession']}: {e}")
            continue
        conn.execute("UPDATE filings SET excerpt = ? WHERE accession = ?", (json.dumps(text), f["accession"]))
        done += 1
        if done % 25 == 0:
            conn.commit()
    conn.commit()
    return done


def mentions(text: str, terms: list[str], limit: int = 700, window: int = 220) -> str:
    """The passages of a document that name one of the terms, centred on the name."""
    flat = re.sub(r"\s+", " ", text)
    flat = re.sub(r"^\s*EX-\S+\s+\d+\s+\S+\.htm\s*", "", flat)  # EDGAR exhibit header
    pattern = re.compile("|".join(re.escape(t) for t in terms), re.I)
    found: list[str] = []
    for sentence in re.split(r"(?<=[.;])\s+(?=[A-Z(“\"])", flat):
        m = pattern.search(sentence)
        if not m:
            continue
        s = sentence.strip()
        if len(s) > 2 * window:  # slide decks and tables run on; keep the part around the name
            a, b = max(0, m.start() - window), min(len(s), m.end() + window)
            s = ("…" if a else "") + s[a:b].strip() + ("…" if b < len(s) else "")
        if s not in found:
            found.append(s)
        if sum(len(x) for x in found) >= limit:
            break
    out = " ".join(found)
    return out if len(out) <= limit else out[:limit].rstrip() + "…"


def search_agreements(conn, ua: str, cfg: dict, ciks: dict[str, int], errors: list[str]) -> int:
    """Material agreements (8-K items 1.01, 1.02, 2.01) filed by other companies that name a covered company.

    Uses SEC full-text search, then reads the matching document for the sentences that mention it.
    """
    acfg = cfg["agreements"]
    wanted = set(acfg["items"])
    start = (date.today() - timedelta(days=cfg["sec"]["history_days"])).isoformat()
    known = {r[0] for r in conn.execute("SELECT key FROM agreements")}
    added = 0
    for ticker, terms in acfg["mentions"].items():
        if ticker not in cfg["watchlist"]:
            continue
        for term in terms:
            hits = []
            for page in range(acfg["max_pages"]):
                q = urlencode({"q": f'"{term}"', "forms": "8-K", "dateRange": "custom", "startdt": start,
                               "enddt": date.today().isoformat(), "from": page * 100})
                try:
                    batch = fetch_json(f"https://efts.sec.gov/LATEST/search-index?{q}", ua=ua)["hits"]["hits"]
                except (FetchError, KeyError) as e:
                    errors.append(f"agreements {term}: {e}")
                    break
                hits += batch
                if len(batch) < 100:
                    break
            for h in hits:
                src = h["_source"]
                if not wanted & set(src.get("items") or []):
                    continue
                adsh, filename = h["_id"].split(":", 1)
                filer_cik = int(src["ciks"][0])
                key = f"{adsh}|{ticker}"
                if filer_cik == ciks.get(ticker) or key in known:
                    continue
                url = f"https://www.sec.gov/Archives/edgar/data/{filer_cik}/{adsh.replace('-', '')}/{filename}"
                try:
                    text = html_text(fetch(url, ua=ua)[:3_000_000])
                except FetchError as e:
                    errors.append(f"agreements {adsh}: {e}")
                    continue
                excerpt = mentions(text, terms)
                if not excerpt:
                    continue
                doc_type = src.get("file_type") or ""
                party = contract_doc(doc_type) and is_party(excerpt, terms)
                amount = stated_amount(excerpt) if party else None
                if party and amount is None and doc_type.startswith("8-K"):
                    amount = stated_amount(" ".join(item_sections(text, list(AGREEMENT_ITEMS)).values()))
                name = re.sub(r"\s*\(CIK \d+\)", "", src["display_names"][0]).strip()
                conn.execute(
                    "INSERT OR IGNORE INTO agreements (key, ticker, filer, filer_cik, form, items, filed, url, excerpt,"
                    " doc_type, relation, amount, amount_text, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (key, ticker, name, filer_cik, src.get("form") or "8-K", ",".join(src.get("items") or []),
                     src["file_date"], url, excerpt, doc_type, "party" if party else "mention",
                     amount[0] if amount else None, amount[1] if amount else None, now()))
                known.add(key)
                added += 1
            conn.commit()
    return added


# XBRL concepts, tried in order; the one with the most recent data wins.
REVENUE = [("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"), ("us-gaap", "Revenues"),
           ("ifrs-full", "Revenue")]
NET_INCOME = [("us-gaap", "NetIncomeLoss"), ("ifrs-full", "ProfitLossAttributableToOwnersOfParent"),
              ("ifrs-full", "ProfitLoss")]


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def periods(facts: list[dict]) -> tuple[str, list[dict]]:
    """Quarterly values when the company files them (Q4 = year minus three quarters), else annual."""
    by_span: dict[tuple[str, str], dict] = {}
    for f in facts:
        if "start" in f and f.get("form") in ("10-Q", "10-K", "20-F", "10-Q/A", "10-K/A", "20-F/A"):
            k = (f["start"], f["end"])
            if k not in by_span or f["filed"] > by_span[k]["filed"]:
                by_span[k] = f
    quarters = {f["end"]: {"start": f["start"], "end": f["end"], "value": f["val"], "derived": 0, "form": f["form"],
                           "filed": f["filed"]} for f in by_span.values() if 80 <= _days(f["start"], f["end"]) <= 100}
    years = [f for f in by_span.values() if 350 <= _days(f["start"], f["end"]) <= 380]
    if not quarters:
        return "FY", sorted(({"start": f["start"], "end": f["end"], "value": f["val"], "derived": 0, "form": f["form"],
                              "filed": f["filed"]} for f in years), key=lambda p: p["end"])
    for y in years:
        inside = [q for q in quarters.values() if _days(y["start"], q["start"]) >= -5 and _days(q["end"], y["end"]) >= -5]
        if len(inside) == 3 and not any(abs(_days(q["end"], y["end"])) <= 5 for q in quarters.values()):
            last = max(q["end"] for q in inside)
            quarters[y["end"]] = {"start": (date.fromisoformat(last) + timedelta(days=1)).isoformat(), "end": y["end"],
                                  "value": y["val"] - sum(q["value"] for q in inside), "derived": 1,
                                  "form": y["form"], "filed": y["filed"]}
    return "Q", sorted(quarters.values(), key=lambda p: p["end"])


def financials(conn, ua: str, ticker: str, cik: int) -> int:
    rows = 0
    for metric, concepts in (("revenue", REVENUE), ("net_income", NET_INCOME)):
        best = None
        for tax, tag in concepts:
            try:
                d = fetch_json(f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik:010d}/{tax}/{tag}.json",
                               ua=ua, retries=1)
            except FetchError:
                continue  # the company doesn't use this tag
            for unit, facts in d["units"].items():
                latest = max((f["end"] for f in facts), default="")
                # most recent data wins; US dollars break a tie
                if best is None or (latest, unit == "USD") > (best[0], best[1] == "USD"):
                    best = (latest, unit, facts)
        if best is None:
            continue
        kind, ps = periods(best[2])
        conn.execute("DELETE FROM financials WHERE ticker = ? AND metric = ?", (ticker, metric))
        for p in ps[-16:]:
            conn.execute("INSERT INTO financials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                         (ticker, metric, kind, p["start"], p["end"], p["value"], best[1], p["derived"],
                          p["form"], p["filed"]))
            rows += 1
    conn.commit()
    return rows


def describe(form: str, items: str, doc_desc: str) -> str:
    if items:
        labels = [ITEM_LABELS.get(i, f"Item {i}") for i in items.split(",") if i and i != "9.01"]
        if labels:
            return "; ".join(labels)
    return doc_desc if doc_desc and doc_desc.upper() != form else ""


def collect(conn, cfg: dict, keys: dict) -> dict:
    ua = user_agent(keys)
    scfg = cfg["sec"]
    forms = set(scfg["forms"])
    ciks = cik_map(ua)
    t_now = datetime.now(timezone.utc)
    since = (t_now - timedelta(days=scfg["history_days"])).strftime("%Y-%m-%dT%H:%M:%SZ")
    new: list[str] = []
    refresh: set[str] = set()
    errors: list[str] = []

    for ticker in cfg["watchlist"]:
        cik = ciks.get(ticker)
        if cik is None:
            errors.append(f"{ticker}: no SEC CIK")
            continue
        sub = fetch_json(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", ua=ua)
        r = sub["filings"]["recent"]
        known = {row[0] for row in conn.execute("SELECT accession FROM filings WHERE cik = ?", (cik,))}
        for i, form in enumerate(r["form"]):
            acc = r["accessionNumber"][i]
            if form not in forms or acc in known:
                continue
            filed = _iso(r["acceptanceDateTime"][i])
            if filed < since:
                continue
            doc = r["primaryDocument"][i]
            folder = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}"
            conn.execute(
                "INSERT INTO filings (accession, ticker, cik, form, items, filed_at, report_date, description, url,"
                " first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (acc, ticker, cik, form, r["items"][i] or "", filed, r["reportDate"][i] or None,
                 describe(form, r["items"][i] or "", r["primaryDocDescription"][i] or ""),
                 f"{folder}/{doc}", now()))
            new.append(acc)
            if form in ("10-Q", "10-K", "20-F"):
                refresh.add(ticker)
        conn.commit()

    enrich(conn, ua, scfg, errors)
    have = {r[0] for r in conn.execute("SELECT DISTINCT ticker FROM financials")}
    for ticker in cfg["watchlist"]:
        if ticker in scfg.get("financials_skip", []):
            continue  # its SEC structured data stopped updating; showing it would be stale
        if ticker in ciks and (ticker in refresh or ticker not in have):
            financials(conn, ua, ticker, ciks[ticker])
    search_agreements(conn, ua, cfg, ciks, errors)
    return {"rows": len(new), "filings": new, "errors": errors}
