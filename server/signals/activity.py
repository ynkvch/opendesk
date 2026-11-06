"""Filings and contract actions rewritten as plain statements, plus the numbers behind them."""
import json
import re
from datetime import date, datetime, timedelta, timezone

from .extract import counterparties, stated_amount
from .sec import ITEM_LABELS, legal_names

ITEM_PHRASES = {
    "1.01": "signed a material agreement", "1.02": "ended a material agreement",
    "1.05": "reported a cybersecurity incident", "2.01": "completed an acquisition or sale of assets",
    "2.02": "published quarterly results", "2.03": "took on a new debt obligation",
    "2.05": "announced restructuring or exit costs", "2.06": "recorded a material impairment",
    "3.01": "received a delisting notice", "3.02": "sold unregistered shares", "4.01": "changed auditor",
    "4.02": "said earlier financial statements can no longer be relied on",
    "5.02": "announced an executive or board change", "5.03": "changed its bylaws or fiscal year",
    "5.07": "reported shareholder vote results", "7.01": "made a public disclosure (Reg FD)",
    "8.01": "disclosed other events",
}
def party(display_name: str) -> str:
    """'CoreWeave, Inc.  (CRWV)' -> 'CoreWeave, Inc.'"""
    return re.sub(r"\s+", " ", re.sub(r"\s*\([^)]*\)\s*$", "", display_name)).strip()


AGREEMENT_ITEMS = ("1.01", "1.02", "2.01")


def own_deal(f, names: dict, legal: dict) -> dict:
    """Other party and stated value from a covered company's own agreement 8-K."""
    ex = json.loads(f["excerpt"]) if f["excerpt"] else {}
    text = " ".join(ex.get(i, "") for i in AGREEMENT_ITEMS)
    others = counterparties(text, [names.get(f["ticker"], ""), legal.get(f["ticker"], "")])
    amt = stated_amount(text)
    return {"counterparty": ", ".join(others) or None, "parties": others, "amount": amt[0] if amt else None,
            "amount_text": amt[1] if amt else None}


def agreement_rows(conn, cfg: dict) -> list[dict]:
    """Deals between a covered company and another company, from SEC 8-Ks: the covered company's own
    agreement filings, plus other companies' filings that name it. Rule-based reading, with the text kept
    so Claude can check it (deals_ai)."""
    names = cfg.get("names", {})
    legal = legal_names()
    out = []
    for f in conn.execute("SELECT * FROM filings WHERE form IN ('8-K', '8-K/A') ORDER BY filed_at DESC"):
        items = [i for i in f["items"].split(",") if i in AGREEMENT_ITEMS]
        if not items:
            continue
        ex = json.loads(f["excerpt"]) if f["excerpt"] else {}
        text = " ".join(ex.get(i, "") for i in items).strip()
        out.append({"key": f["accession"], "date": f["filed_at"][:10], "ticker": f["ticker"],
                    "company": names.get(f["ticker"], f["ticker"]), "filed_by": names.get(f["ticker"], f["ticker"]),
                    "watched": legal.get(f["ticker"], names.get(f["ticker"], f["ticker"])),
                    "own": True, "relation": "party", "what": "; ".join(ITEM_LABELS.get(i, i) for i in items),
                    "excerpt": text or None, "text": text, "url": f["url"], **own_deal(f, names, legal)})
    for g in conn.execute("SELECT * FROM agreements ORDER BY filed DESC"):
        items = [i for i in g["items"].split(",") if i in AGREEMENT_ITEMS]
        out.append({"key": g["key"], "date": g["filed"], "ticker": g["ticker"],
                    "company": names.get(g["ticker"], g["ticker"]), "filed_by": party(g["filer"]),
                    "watched": legal.get(g["ticker"], names.get(g["ticker"], g["ticker"])), "own": False,
                    "relation": g["relation"] or "mention", "counterparty": party(g["filer"]),
                    "amount": g["amount"], "amount_text": g["amount_text"],
                    "what": "; ".join(ITEM_LABELS.get(i, i) for i in items), "excerpt": g["excerpt"],
                    "text": g["excerpt"] or "", "url": g["url"]})
    out.sort(key=lambda r: r["date"], reverse=True)
    return out


def with_ai(conn, rows: list[dict]) -> list[dict]:
    """Prefer Claude's reading where it exists; keep the rule-based one otherwise."""
    ai = {r["key"]: r for r in conn.execute("SELECT * FROM deal_ai")}
    out = []
    for r in rows:
        r = {k: v for k, v in r.items() if k != "text"}
        a = ai.get(r["key"])
        r["checked_by"] = "rules"
        if a:
            r["checked_by"] = "claude"
            parties = json.loads(a["counterparties"])
            if not r["own"]:
                r["relation"] = "party" if a["is_party"] else "mention"
                parties = parties or [r["filed_by"]]
            r["counterparty"] = ", ".join(parties) or None
            r["parties"] = parties
            r["amount"], r["amount_text"] = a["amount_usd"], a["amount_quote"]
            r["deal_type"], r["summary"] = a["deal_type"], a["summary"]
        out.append(r)
    return out


def agreements(conn, cfg: dict) -> list[dict]:
    return with_ai(conn, agreement_rows(conn, cfg))


def few(deal: dict) -> str:
    """'A, B and 5 others' for long lists such as the banks underwriting a bond sale."""
    p = deal.get("parties") or ([deal["counterparty"]] if deal.get("counterparty") else [])
    return ", ".join(p) if len(p) <= 3 else f"{p[0]}, {p[1]} and {len(p) - 2} others"


def money(v: float) -> str:
    a = abs(v)
    s = f"${a / 1e9:.2f}B" if a >= 1e9 else f"${a / 1e6:.1f}M" if a >= 1e6 else f"${a:,.0f}"
    return ("−" if v < 0 else "") + s


def in_cur(v: float, cur: str) -> str:
    return money(v) if cur == "USD" else f"{money(v).replace('$', '')} {cur}"


def long_date(iso: str) -> str:
    d = date.fromisoformat(iso[:10])
    return f"{d.strftime('%b')} {d.day}, {d.year}"


def _near(rows: list[dict], end: str, days: int = 7) -> dict | None:
    target = date.fromisoformat(end)
    best = min(rows, key=lambda r: abs((date.fromisoformat(r["end"]) - target).days), default=None)
    return best if best and abs((date.fromisoformat(best["end"]) - target).days) <= days else None


def build(conn, cfg: dict) -> dict:
    names = cfg.get("names", {})
    deals = {r["key"]: r for r in agreements(conn, cfg)}
    acfg = cfg["activity"]
    since = (datetime.now(timezone.utc) - timedelta(days=cfg["sec"]["history_days"])).strftime("%Y-%m-%dT%H:%M:%SZ")
    flags = {r["ref"]: {"id": r["id"], "severity": r["severity"], "seen": r["seen"]}
             for r in conn.execute("SELECT id, ref, severity, seen FROM flags WHERE kind != 'series'")}

    fin: dict[str, dict] = {}
    for r in conn.execute("SELECT * FROM financials ORDER BY end"):
        f = fin.setdefault(r["ticker"], {"period": r["period"], "currency": r["currency"], "revenue": [], "net_income": []})
        f[r["metric"]].append({"start": r["start"], "end": r["end"], "value": r["value"], "derived": r["derived"]})

    events = []
    for f in conn.execute("SELECT * FROM filings WHERE filed_at >= ? ORDER BY filed_at DESC", (since,)):
        t, form = f["ticker"], f["form"]
        co = names.get(t, t)
        flag = flags.get(f"filing:{f['accession']}")
        base = {"ticker": t, "company": co, "filed_at": f["filed_at"], "url": f["url"], "flag": flag,
                "form": form}

        if form in ("8-K", "8-K/A"):
            items = [i for i in f["items"].split(",") if i and i != "9.01"]
            if not items:
                continue
            excerpt = json.loads(f["excerpt"]) if f["excerpt"] else {}
            phrases = [ITEM_PHRASES.get(i, ITEM_LABELS.get(i, f"filed item {i}").lower()) for i in items]
            deal = deals.get(f["accession"])
            if items[0] in AGREEMENT_ITEMS and deal:
                if deal.get("counterparty"):
                    phrases[0] += f" with {few(deal)}"
                if deal.get("amount"):
                    phrases[0] += f" (stated value {money(deal['amount'])})"
            text = f"{co} {phrases[0]}" + (f", and {'; '.join(phrases[1:])}" if len(phrases) > 1 else "") + "."
            events.append({**base, "id": f"f:{f['accession']}", "kind": "event", "date": f["filed_at"][:10],
                           "sentence": text, "value": None, "significant": True,
                           "excerpt": [{"item": i, "label": ITEM_LABELS.get(i, i), "text": excerpt[i]}
                                       for i in items if excerpt.get(i)]})
            continue

        if form in ("10-Q", "10-K", "20-F") and f["report_date"]:
            span = "quarter" if form == "10-Q" else "year" if form == "20-F" else "fiscal year"
            text = f"{co} filed its {form} for the {span} ended {long_date(f['report_date'])}"
            data = None
            tf = fin.get(t)
            if tf:
                rev = _near(tf["revenue"], f["report_date"])
                ni = _near(tf["net_income"], f["report_date"])
                prev = _near(tf["revenue"], (date.fromisoformat(f["report_date"]) - timedelta(days=364)).isoformat(), 12) if rev else None
                if rev:
                    cur = tf["currency"]
                    text += f": {'revenue' if tf['period'] == 'FY' else 'quarterly revenue'} {in_cur(rev['value'], cur)}"
                    if prev and prev["value"] > 0:
                        text += f" ({rev['value'] / prev['value'] - 1:+.0%} y/y)"
                    if ni:
                        text += f", net income {in_cur(ni['value'], cur)}"
                    data = {"revenue": rev["value"], "revenue_prev": prev["value"] if prev else None,
                            "net_income": ni["value"] if ni else None, "currency": cur}
            events.append({**base, "id": f"f:{f['accession']}", "kind": "report", "date": f["filed_at"][:10],
                           "sentence": text + ".", "value": None, "data": data, "significant": True})
            continue

        simple = {
            "6-K": (f"{co} furnished a report to the SEC (6-K).", False),
            "NT 10-K": (f"{co} said its annual report will be filed late.", True),
            "NT 10-Q": (f"{co} said its quarterly report will be filed late.", True),
            "S-3": (f"{co} registered securities it may sell later (shelf registration).", True),
            "S-3ASR": (f"{co} registered securities it may sell later (automatic shelf registration).", True),
        }
        if form in simple:
            text, sig = simple[form]
        elif "13D" in form:
            text, sig = f"An investor holding over 5% of {co} filed {form}, which signals intent to influence the company.", True
        elif "13G" in form:
            text, sig = f"A passive investor holding over 5% of {co} filed {form}.", False
        else:
            continue
        events.append({**base, "id": f"f:{f['accession']}", "kind": "ownership" if "13" in form else "filing",
                       "date": f["filed_at"][:10], "sentence": text, "value": None,
                       "significant": sig or bool(flag)})

    for a in conn.execute("SELECT * FROM awards ORDER BY action_date DESC"):
        amt = a["amount"]
        if not amt:
            continue  # paperwork modifications that move no money
        co = names.get(a["ticker"], a["ticker"])
        agency = f"the {a['agency']}" if a["agency"] else "a federal agency"
        new = not a["modification"] or a["modification"] == "0"
        if amt < 0:
            text = f"{agency[0].upper()}{agency[1:]} removed {money(-amt)} from a {co} contract"
        elif new:
            text = f"{co} won a {money(amt)} federal contract from {agency}"
        else:
            text = f"{co} got {money(amt)} added to an existing contract with {agency}"
        flag = flags.get(f"award:{a['key']}")
        events.append({
            "id": f"a:{a['key']}", "kind": "contract", "ticker": a["ticker"], "company": co, "date": a["action_date"],
            "filed_at": None, "url": a["url"], "flag": flag, "form": None, "sentence": text + ".",
            "value": amt, "agency": a["agency"], "recipient": a["recipient"], "modification": a["modification"],
            "description": a["description"], "new_award": new,
            "significant": bool(flag) or abs(amt) >= acfg["contract_min_amount"],
        })

    for g in conn.execute("SELECT * FROM agreements WHERE filed >= ? ORDER BY filed DESC", (since[:10],)):
        co = names.get(g["ticker"], g["ticker"])
        filer = party(g["filer"])
        deal = deals.get(g["key"], {})
        is_deal = deal.get("relation", g["relation"]) == "party"
        if is_deal:
            items = [i for i in g["items"].split(",") if i in AGREEMENT_ITEMS]
            text = f"{filer} {ITEM_PHRASES[items[0] if items else '1.01']} with {co}"
            if deal.get("amount"):
                text += f" (stated value {money(deal['amount'])})"
        else:
            text = f"{filer} filed a document that mentions {co}"
        events.append({
            "id": f"g:{g['key']}", "kind": "agreement", "ticker": g["ticker"], "company": co, "date": g["filed"],
            "filed_at": None, "url": g["url"], "flag": None, "form": g["form"], "party": filer,
            "sentence": text + ".", "value": None, "significant": is_deal,
            "excerpt": [{"item": "", "label": f"Where {co} is named", "text": g["excerpt"]}],
        })

    events.sort(key=lambda e: (e["date"], e["filed_at"] or ""), reverse=True)
    return {"watchlist": cfg["watchlist"], "names": names, "events": events, "financials": fin}
