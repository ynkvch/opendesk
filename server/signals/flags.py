"""Turn collected data into flags. Every threshold comes from config.json.

Series are judged against their own history (no consensus forecasts are available for free):
- a z-score of the latest year-over-year growth against the previous `history_months` of y/y growth
- y/y growth changing sign
"""
import statistics
from datetime import datetime, timedelta, timezone

from .store import add_flag

RANK = {"info": 0, "notable": 1, "major": 2}
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()


def shift(period: str, months: int) -> str:
    y, m = map(int, period.split("-"))
    k = y * 12 + (m - 1) + months
    return f"{k // 12}-{k % 12 + 1:02d}"


def label(period: str) -> str:
    y, m = period.split("-")
    return f"{MONTHS[int(m) - 1]} {y}"


def usd(v: float) -> str:
    a = abs(v)
    s = f"${a / 1e9:.2f}B" if a >= 1e9 else f"${a / 1e6:.1f}M" if a >= 1e6 else f"${a:,.0f}"
    return ("−" if v < 0 else "") + s


def _growth(cur: float | None, prev: float | None) -> float | None:
    if cur is None or prev is None or prev <= 0:
        return None
    return cur / prev - 1


def series_stats(obs: list[tuple[str, float]], history: int, reported: dict[str, float] | None = None) -> dict | None:
    """Latest value, growth rates and how unusual the latest y/y growth is. Where a year-earlier value is
    missing, the y/y change the source itself reported (percent) is used instead."""
    if not obs:
        return None
    vals = dict(obs)
    periods = [p for p, _ in obs]
    latest = periods[-1]
    yoy_by = {p: g for p in periods if (g := _growth(vals[p], vals.get(shift(p, -12)))) is not None}
    for p, pct in (reported or {}).items():
        yoy_by.setdefault(p, pct / 100)
    yoy = yoy_by.get(latest)
    hist = [yoy_by[p] for p in periods[:-1] if p in yoy_by][-history:]
    z = None
    if yoy is not None and len(hist) >= 12:
        sd = statistics.pstdev(hist)
        if sd > 0:
            z = (yoy - statistics.fmean(hist)) / sd
    recent = [yoy_by[p] for p in periods if p in yoy_by]
    accel = None
    if len(recent) >= 6:
        accel = statistics.fmean(recent[-3:]) - statistics.fmean(recent[-6:-3])
    return {
        "latest": latest,
        "value": vals[latest],
        "yoy": yoy,
        "prev_yoy": yoy_by.get(shift(latest, -1)),
        "mom": _growth(vals[latest], vals.get(shift(latest, -1))),
        "z": z,
        "n_hist": len(hist),
        "accel": accel,  # change in the 3-month average of y/y growth
    }


def series_tickers(cfg: dict, series_id: str) -> list[str]:
    """Tickers you've linked to a series. A key matches the id itself or any id under it ('kr:854232')."""
    return sorted({t for k, ts in cfg.get("series_tickers", {}).items()
                   if series_id == k or series_id.startswith(k + ":") for t in ts})


def series_flags(conn, cfg: dict, source: str) -> int:
    fcfg = cfg["flags"]
    raised = 0
    for s in conn.execute("SELECT * FROM series WHERE source = ?", (source,)).fetchall():
        rows = conn.execute("SELECT period, value, first_seen FROM observations WHERE series_id = ? ORDER BY period",
                            (s["id"],)).fetchall()
        st = series_stats([(r["period"], r["value"]) for r in rows], fcfg["history_months"])
        if not st or st["yoy"] is None:
            continue
        sev = None
        reasons = []
        z = st["z"]
        if z is not None and abs(z) >= fcfg["z_notable"]:
            sev = "major" if abs(z) >= fcfg["z_major"] else "notable"
            reasons.append(f"Y/y growth is {abs(z):.1f} standard deviations {'above' if z > 0 else 'below'}"
                           f" its average of the previous {st['n_hist']} months")
        prev = st["prev_yoy"]
        if fcfg["flag_yoy_sign_change"] and prev is not None and (prev >= 0) != (st["yoy"] >= 0):
            sev = sev if sev and RANK[sev] >= RANK["notable"] else "notable"
            reasons.append(f"Y/y growth turned {'positive' if st['yoy'] >= 0 else 'negative'}")
        if not sev:
            continue
        detail = ". ".join(reasons) + "."
        if prev is not None:
            detail += f" Previous month: {prev:+.1%} y/y."
        direction = (1 if z > 0 else -1) if z is not None and abs(z) >= fcfg["z_notable"] else (1 if st["yoy"] >= 0 else -1)
        raised += add_flag(
            conn, ref=f"series:{s['id']}:{st['latest']}", kind="series", severity=sev, direction=direction,
            title=f"{s['name']}: {st['yoy']:+.1%} y/y in {label(st['latest'])}", detail=detail, url=s["url"],
            event_at=rows[-1]["first_seen"], tickers=series_tickers(cfg, s["id"]))
    conn.commit()
    return raised


def filing_flags(conn, cfg: dict, accessions: list[str]) -> int:
    scfg = cfg["sec"]
    cut = (datetime.now(timezone.utc) - timedelta(days=scfg["flag_recent_days"])).strftime("%Y-%m-%dT%H:%M:%SZ")
    raised = 0
    for acc in accessions:
        f = conn.execute("SELECT * FROM filings WHERE accession = ?", (acc,)).fetchone()
        if f is None or f["filed_at"] < cut:
            continue
        t, form, desc = f["ticker"], f["form"], f["description"] or ""
        kind, sev, direction, detail = "filing", None, 0, ""
        if form in ("8-K", "8-K/A"):
            sevs = [scfg["item_severity"][i] for i in f["items"].split(",") if i in scfg["item_severity"]]
            if not sevs:
                continue
            sev = max(sevs, key=RANK.__getitem__)
            title = f"{t} {form}: {desc}"
        elif form == "6-K":
            sev, title = "info", f"{t} 6-K report (foreign issuer)"
        elif form in scfg["form_severity"]:
            sev, title = scfg["form_severity"][form], f"{t} {form}" + (f": {desc}" if desc else "")
        elif form in ("10-Q", "10-K", "20-F"):
            sev, title = "info", f"{t} {form} filed"
        else:
            continue
        raised += add_flag(conn, ref=f"filing:{acc}", kind=kind, severity=sev, direction=direction, title=title,
                           detail=detail, url=f["url"], event_at=f["filed_at"], tickers=[t])

    conn.commit()
    return raised


def award_flags(conn, cfg: dict, keys: list[str]) -> int:
    floor = cfg["usaspending"]["flag_min_amount"]
    raised = 0
    for k in keys:
        a = conn.execute("SELECT * FROM awards WHERE key = ?", (k,)).fetchone()
        if a is None or abs(a["amount"]) < floor:
            continue
        verb = "cut" if a["amount"] < 0 else "award"
        raised += add_flag(
            conn, ref=f"award:{k}", kind="award", severity="major" if abs(a["amount"]) >= 10 * floor else "notable",
            direction=-1 if a["amount"] < 0 else 1,
            title=f"{a['ticker']} federal contract {verb}: {usd(a['amount'])} from {a['agency'] or 'unknown agency'}",
            detail=f"{a['recipient']}. {a['description'][:280]}", url=a["url"],
            event_at=a["action_date"] + "T00:00:00Z", tickers=[a["ticker"]])
    conn.commit()
    return raised
