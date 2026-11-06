"""market regime signals: six macro readings, each with its own rule.

All free:
  2s10s curve     FRED T10Y2Y, with T10Y3M and DGS10 (is the 10Y rising while the curve steepens?)
  Credit spreads  FRED BAMLH0A0HYM2 (high yield) and BAMLC0A0CM (investment grade)
  Liquidity       FRED TREAST (Treasuries the Fed holds) and WTREGEN (Treasury General Account)
  ISM PMIs        headline figures from ISM's releases on PR Newswire (ismworld.org sits behind a captcha)
  VIX             CBOE daily history, then CBOE's 15-minute delayed quote on every run

each signal is read with its own fixed rule. where a rule leaves a number open (how long "rising 30%" takes,
when a 10-session move counts as flat) the choice is written in `rule_used`. there's no rule for combining
signals into one regime, so none is made here: each signal lists the regimes it points to and the call stays
with the reader.
"""
import csv
import io
import json
import re
import subprocess
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from .http import FetchError, fetch
from .store import MissingKey, now

FRED_SERIES = ["T10Y2Y", "T10Y3M", "DGS3MO", "DGS2", "DGS10", "BAMLH0A0HYM2", "BAMLC0A0CM", "TREAST", "WTREGEN"]
ISM_LIST = "https://www.prnewswire.com/news/institute-for-supply-management/?page={page}&pagesize=100"
ISM_SLUG = re.compile(r"/news-releases/(manufacturing|services)-pmi-at-(\d{2})(?:-(\d))?-([a-z]+)-(\d{4})-[a-z0-9-]*\.html")
MONTHS = "january february march april may june july august september october november december".split()
NY = ZoneInfo("America/New_York")

REGIMES = {
    "growth_up": "Growth accelerating",
    "growth_down": "Growth decelerating",
    "inflation": "Inflation dominant",
    "risk_off": "Risk-off / liquidity crisis",
    "liquidity": "Liquidity expansion",
    "uncertain": "Regime uncertain",
}


def _put(conn, series: str, d: str, v: float) -> bool:
    t = now()
    row = conn.execute("SELECT value FROM regime_obs WHERE series = ? AND date = ?", (series, d)).fetchone()
    if row is None:
        conn.execute("INSERT INTO regime_obs (series, date, value, first_seen, updated_at) VALUES (?, ?, ?, ?, ?)",
                     (series, d, v, t, t))
        return True
    if abs(row[0] - v) > 1e-9:
        conn.execute("UPDATE regime_obs SET value = ?, updated_at = ? WHERE series = ? AND date = ?", (v, t, series, d))
    return False


def _covers(conn, series: str, start: str) -> bool:
    """True when stored history reaches back to within a month of `start`."""
    first = conn.execute("SELECT MIN(date) FROM regime_obs WHERE series = ?", (series,)).fetchone()[0]
    return first is not None and first <= (date.fromisoformat(start) + timedelta(days=31)).isoformat()


def _latest_date(conn, series: str) -> str | None:
    return conn.execute("SELECT MAX(date) FROM regime_obs WHERE series = ?", (series,)).fetchone()[0]


def _due(conn, key: str, minutes: float) -> bool:
    """For sources that change rarely: True at most once per `minutes`, remembered in regime_state."""
    row = conn.execute("SELECT changed_at FROM regime_state WHERE signal = ?", (f"_{key}",)).fetchone()
    if row and datetime.now(timezone.utc) - datetime.fromisoformat(row[0].replace("Z", "+00:00")) < timedelta(minutes=minutes):
        return False
    conn.execute("INSERT INTO regime_state (signal, state, changed_at) VALUES (?, '', ?)"
                 " ON CONFLICT(signal) DO UPDATE SET changed_at = excluded.changed_at", (f"_{key}", now()))
    return True


def _fred(conn, start: str, key: str) -> tuple[int, list[str]]:
    new, errors = 0, []
    for sid in FRED_SERIES:
        last = _latest_date(conn, sid)
        # re-read the last month so revisions land; go back to `start` when it moved earlier
        since = (date.fromisoformat(last) - timedelta(days=30)).isoformat() if last and _covers(conn, sid, start) else start
        q = urlencode({"series_id": sid, "api_key": key, "file_type": "json", "observation_start": since})
        try:
            data = json.loads(fetch(f"https://api.stlouisfed.org/fred/series/observations?{q}"))
        except FetchError as e:
            errors.append(f"{sid}: {e}")
            continue
        for o in data["observations"]:
            try:
                new += _put(conn, sid, o["date"], float(o["value"]))
            except ValueError:
                continue  # '.' marks a holiday
    return new, errors


def _vix(conn, start: str) -> int:
    new = 0
    last = _latest_date(conn, "VIX")
    if last is None or date.fromisoformat(last) < date.today() - timedelta(days=4) or not _covers(conn, "VIX", start):
        body = fetch("https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv", timeout=60).decode()
        reader = csv.reader(io.StringIO(body))
        next(reader)
        for r in reader:
            d = datetime.strptime(r[0], "%m/%d/%Y").date().isoformat()
            if d >= start:
                new += _put(conn, "VIX", d, float(r[4]))
    q = json.loads(fetch("https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json"))
    price = q["data"].get("current_price")
    if price:
        # dated by the session the price belongs to (the quote's own timestamp is UTC, which runs a day ahead
        # every evening); today's row moves until the close
        new += _put(conn, "VIX", (q["data"].get("last_trade_time") or q["timestamp"])[:10], float(price))
    return new


def _treasury(conn) -> int:
    """Same-day closing yields from the Treasury's own daily yield curve, posted the afternoon of each trading day.
    FRED carries the same numbers (DGS3MO/DGS2/DGS10) but a day later; the spreads are filled in from them too."""
    year = datetime.now(NY).year
    url = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/"
           f"{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv")
    rows = list(csv.DictReader(io.StringIO(fetch(url).decode())))
    new = 0
    for r in rows:
        d = datetime.strptime(r["Date"], "%m/%d/%Y").date().isoformat()
        try:
            m3, y2, y10 = float(r["3 Mo"]), float(r["2 Yr"]), float(r["10 Yr"])
        except (KeyError, ValueError):
            continue
        for sid, v in (("DGS3MO", m3), ("DGS2", y2), ("DGS10", y10),
                       ("T10Y2Y", round(y10 - y2, 2)), ("T10Y3M", round(y10 - m3, 2))):
            new += _put(conn, sid, d, v)
    return new


def _ism(conn, start: str) -> int:
    # releases come out on the 1st and 3rd business days; outside those days check twice a day
    day = datetime.now(NY).day
    if not _due(conn, "ism_checked", 60 if day <= 7 or _latest_date(conn, "ISM_MFG") is None else 720):
        return 0
    pages = 1 if _covers(conn, "ISM_MFG", start) else 20
    new = 0
    for n in range(1, pages + 1):
        found = set(ISM_SLUG.findall(fetch(ISM_LIST.format(page=n)).decode("utf-8", "ignore")))
        for kind, whole, tenth, month, year in found:
            if month not in MONTHS:
                continue
            value = int(whole) + (int(tenth) / 10 if tenth else 0)
            new += _put(conn, "ISM_MFG" if kind == "manufacturing" else "ISM_SVC",
                        f"{year}-{MONTHS.index(month) + 1:02d}-01", value)
        if not found or min(f"{y}" for *_, y in found) < start[:4]:
            break
    return new


def collect(conn, cfg: dict, keys: dict) -> dict:
    rcfg = cfg["regime"]
    key = keys.get("fred_api_key")
    if not key:
        raise MissingKey("Add fred_api_key to data/keys.json (free key: fredaccount.stlouisfed.org → API Keys)")
    new, errors = _fred(conn, rcfg["start"], key)
    conn.commit()
    for name, step in (("Treasury", lambda: _treasury(conn)), ("VIX", lambda: _vix(conn, rcfg["start"])),
                       ("ISM", lambda: _ism(conn, rcfg["start"]))):
        try:
            new += step()
        except (FetchError, KeyError, ValueError) as e:
            errors.append(f"{name}: {e}")
        conn.commit()
    result = evaluate(conn)
    score = result["score"]
    # the overall label is tracked like a signal, so a switch between risk-on, neutral and risk-off notifies too
    changes = _record_changes(conn, result["signals"] + [{"key": "score", "title": "Regime score",
                                                            "reading": score["label"]}])
    if changes and rcfg.get("notify"):
        _notify(changes)
    return {"rows": new, "errors": errors, "changes": changes}


def _record_changes(conn, signals: list[dict]) -> list[str]:
    out = []
    for s in signals:
        if s["reading"] is None:
            continue
        row = conn.execute("SELECT state FROM regime_state WHERE signal = ?", (s["key"],)).fetchone()
        if row is None or row[0] != s["reading"]:
            conn.execute("INSERT INTO regime_state (signal, state, changed_at) VALUES (?, ?, ?)"
                         " ON CONFLICT(signal) DO UPDATE SET state = excluded.state, changed_at = excluded.changed_at",
                         (s["key"], s["reading"], now()))
            if row is not None:
                out.append(f"{s['title']}: {row[0]} → {s['reading']}")
    conn.commit()
    return out


def _notify(changes: list[str]) -> None:
    text = "; ".join(changes)[:240].replace('"', "'")
    subprocess.run(["osascript", "-e", f'display notification "{text}" with title "Regime signal changed"'],
                   check=False, capture_output=True)


# ---------- reading the signals ----------

def _series(conn, sid: str) -> list[tuple[str, float]]:
    return [(r[0], r[1]) for r in conn.execute("SELECT date, value FROM regime_obs WHERE series = ? ORDER BY date", (sid,))]


def _back(xs: list[tuple[str, float]], n: int) -> float | None:
    return xs[-1 - n][1] if len(xs) > n else None


def _first_seen(conn, sid: str, d: str) -> str | None:
    row = conn.execute("SELECT first_seen FROM regime_obs WHERE series = ? AND date = ?", (sid, d)).fetchone()
    return row[0] if row else None


def _line(label: str, xs: list[tuple[str, float]], unit: str, axis: str = "left") -> dict:
    return {"label": label, "unit": unit, "axis": axis, "points": [[d, v] for d, v in xs]}


def _base(conn, key, title, source, cadence, rule, sid, xs, unit, label) -> dict:
    last = xs[-1] if xs else None
    changed = conn.execute("SELECT changed_at FROM regime_state WHERE signal = ?", (key,)).fetchone()
    return {"key": key, "title": title, "source": source, "cadence": cadence, "rule": rule, "rule_used": "",
            "unit": unit, "value": last[1] if last else None, "as_of": last[0] if last else None,
            "received": _first_seen(conn, sid, last[0]) if last else None,
            "reading_since": changed[0] if changed else None,
            "reading": None, "tone": "ink", "points_to": [], "lines": [], "notes": [],
            "series": [_line(label, xs, unit)], "levels": []}


CURVE_RULE = ("Positive and steepening = growth. Inverted = risk-off preparation. Sustained inversion above three"
              " months is the reliable recession precursor; bull steepening out of an inversion often comes first.")


def _curve(conn) -> list[dict]:
    """2s10s and 3m10y on separate cards, each against the 10-year yield (the end that tells growth steepening
    from bull steepening). only 2s10s votes, so 3m10y is read the same way but points to no regime."""
    y10 = _series(conn, "DGS10")
    two = _base(conn, "curve", "2s10s yield spread", "FRED: T10Y2Y, DGS2, DGS10", "Daily", CURVE_RULE,
                "T10Y2Y", _series(conn, "T10Y2Y"), "pct", "2s10s")
    three = _base(conn, "curve_3m", "3m10y yield spread", "FRED: T10Y3M, DGS3MO, DGS10", "Daily",
                  CURVE_RULE + " 3m10y is watched beside 2s10s, but only 2s10s votes, so this card points to"
                  " no regime.", "T10Y3M", _series(conn, "T10Y3M"), "pct", "3m10y")
    for s, sid, votes in ((two, "T10Y2Y", True), (three, "T10Y3M", False)):
        s["series"].append(_line("10Y Treasury", y10, "pct", "right"))
        s["levels"] = [{"value": 0, "label": "Inverted below"}]
        s["rule_used"] = ("Steepening or flattening = change over 20 sessions, ignoring moves under 5 bp. The 10Y's"
                          " direction over the same 20 sessions separates growth steepening (10Y rising) from bull"
                          " steepening (10Y falling).")
        _read_curve(s, _series(conn, sid), y10, votes)
    # each card draws its two legs; the gap between them is the spread the reading uses
    for s, sid, label in ((two, "DGS2", "2Y Treasury"), (three, "DGS3MO", "3M Treasury bill")):
        short = _series(conn, sid)
        s["series"] = [_line(label, short, "pct"), _line("10Y Treasury", y10, "pct")]
        s["levels"] = []
        if len(short) > 20:
            name = label.split(" ")[0]
            s["lines"][1:1] = [{"label": label, "value": short[-1][1], "unit": "pct"},
                               {"label": f"{name}, 20-session change", "value": (short[-1][1] - _back(short, 20)) * 100,
                                "unit": "bp"}]
    return [two, three]


def _read_curve(s: dict, xs: list[tuple[str, float]], y10: list[tuple[str, float]], votes: bool) -> None:
    if len(xs) < 21:
        return
    v, chg = xs[-1][1], (xs[-1][1] - _back(xs, 20)) * 100
    y_chg = (y10[-1][1] - _back(y10, 20)) * 100 if len(y10) > 20 else None
    run = 0
    for _, x in reversed(xs):
        if x >= 0:
            break
        run += 1
    # longest inversion that ended within the last 12 months
    year_ago = (date.fromisoformat(xs[-1][0]) - timedelta(days=365)).isoformat()
    longest, cur = 0, 0
    for d, x in xs:
        cur = cur + 1 if x < 0 else 0
        if d >= year_ago:
            longest = max(longest, cur)
    s["lines"] = [{"label": "20-session change", "value": chg, "unit": "bp"},
                  {"label": "10Y Treasury", "value": y10[-1][1] if y10 else None, "unit": "pct"},
                  {"label": "10Y, 20-session change", "value": y_chg, "unit": "bp"}]
    if v < 0:
        s.update(reading="Inverted", tone="neg", points_to=["risk_off"])
        if run >= 63:
            s["notes"].append(f"Inverted for {run} sessions, over three months: the classic recession precursor.")
    elif abs(chg) < 5:
        s.update(reading="Flat", tone="ink")
    elif chg > 0 and (y_chg or 0) > 0:
        s.update(reading="Positive and steepening", tone="pos", points_to=["growth_up"])
    elif chg > 0:
        s.update(reading="Bull steepening", tone="warn", points_to=["growth_down"])
        s["notes"].append("Steepening with the 10Y falling: short rates are dropping faster. This often comes"
                          " before the deterioration.")
    else:
        s.update(reading="Flattening", tone="warn", points_to=["growth_down"])
    if v >= 0 and longest >= 63:
        s["notes"].append(f"Came out of a {longest}-session inversion in the last 12 months. The un-inversion is"
                          " often the more urgent signal.")
    if not votes:
        s["points_to"] = []


def _credit(conn, vix: list[tuple[str, float]]) -> list[dict]:
    """HY and IG on separate cards, each against the 10-year Treasury yield (the rate part the spread leaves out)."""
    hy, ig, y10 = _series(conn, "BAMLH0A0HYM2"), _series(conn, "BAMLC0A0CM"), _series(conn, "DGS10")
    h = _base(conn, "credit", "HY credit spread", "FRED: BAMLH0A0HYM2, DGS10", "Daily",
              "Tightening = risk-on. Widening > 50 bp in 10 sessions = caution. Direction matters more than level; a 50 bp"
              " widening with a stable VIX is a credit warning equities have not priced yet.",
              "BAMLH0A0HYM2", hy, "pct", "HY spread")
    g = _base(conn, "credit_ig", "IG credit spread", "FRED: BAMLC0A0CM, DGS10", "Daily",
              "IG is read beside HY but has no threshold of its own: tightening = risk appetite"
              " expanding, widening = credit stress.", "BAMLC0A0CM", ig, "pct", "IG spread")
    for s in (h, g):
        s["series"].append(_line("10Y Treasury", y10, "pct", "right"))
    h["rule_used"] = ("Change over 10 sessions; moves under 5 bp count as flat. Stable VIX = VIX up less than 10% over"
                      " the same 10 sessions.")
    g["rule_used"] = ("Same 10-session reading as HY, shown for direction only: with no IG rule of its own it points"
                      " to no regime.")
    y_chg = (y10[-1][1] - _back(y10, 10)) * 100 if len(y10) > 10 else None
    if len(hy) > 10:
        chg = (hy[-1][1] - _back(hy, 10)) * 100
        h["lines"] = [{"label": "10-session change", "value": chg, "unit": "bp"},
                      {"label": "10Y Treasury", "value": y10[-1][1] if y10 else None, "unit": "pct"},
                      {"label": "10Y, 10-session change", "value": y_chg, "unit": "bp"}]
        if chg >= 50:
            h.update(reading="Widening over 50 bp", tone="neg", points_to=["risk_off"])
            if len(vix) > 10 and vix[-1][1] / _back(vix, 10) - 1 < 0.10:
                h["notes"].append("VIX is stable while HY widens: a credit warning equities have not priced yet.")
        elif chg >= 5:
            h.update(reading="Widening", tone="warn")
        elif chg <= -5:
            h.update(reading="Tightening", tone="pos", points_to=["growth_up"])
        else:
            h.update(reading="Flat", tone="ink")
    if len(ig) > 10:
        chg = (ig[-1][1] - _back(ig, 10)) * 100
        g["lines"] = [{"label": "10-session change", "value": chg, "unit": "bp"},
                      {"label": "10Y Treasury", "value": y10[-1][1] if y10 else None, "unit": "pct"},
                      {"label": "10Y, 10-session change", "value": y_chg, "unit": "bp"}]
        g.update(reading="Widening" if chg >= 5 else "Tightening" if chg <= -5 else "Flat",
                 tone="warn" if chg >= 5 else "pos" if chg <= -5 else "ink")
    return [h, g]


def _liquidity(conn) -> dict:
    tr, tga = _series(conn, "TREAST"), _series(conn, "WTREGEN")
    s = _base(conn, "liquidity", "TREAST + TGA", "FRED: TREAST + WTREGEN", "Weekly (Thursday)",
              "TREAST rising while TGA declines: reserves expanding, liquidity expansion, growth and high-beta lead."
              " TREAST falling or TGA refilling: liquidity tightening. Both supportive = expansion; both tightening = reduce risk.",
              "TREAST", tr, "usd_m", "TREAST")
    s["series"].append(_line("TGA", tga, "usd_m", "right"))
    s["rule_used"] = "Rising or falling = change over the last 4 weeks; changes under $5bn count as flat."
    if len(tr) < 5 or len(tga) < 5:
        return s
    d_tr, d_tga = tr[-1][1] - _back(tr, 4), tga[-1][1] - _back(tga, 4)
    s["lines"] = [{"label": "TREAST, 4-week change", "value": d_tr, "unit": "usd_m"},
                  {"label": "TGA balance", "value": tga[-1][1], "unit": "usd_m"},
                  {"label": "TGA, 4-week change", "value": d_tga, "unit": "usd_m"}]
    sup_tr, tight_tr = d_tr > 5000, d_tr < -5000
    sup_tga, tight_tga = d_tga < -5000, d_tga > 5000
    if sup_tr and sup_tga:
        s.update(reading="Both supportive", tone="pos", points_to=["liquidity"])
    elif tight_tr and tight_tga:
        s.update(reading="Both tightening", tone="neg", points_to=["risk_off"])
    elif tight_tr or tight_tga:
        s.update(reading="Tightening (" + ("TREAST falling" if tight_tr else "TGA refilling") + ")", tone="warn",
                 points_to=["growth_down"])
    else:
        s.update(reading="No clear direction", tone="ink")
    return s


def _ism_signals(conn) -> list[dict]:
    mfg, svc = _series(conn, "ISM_MFG"), _series(conn, "ISM_SVC")
    m = _base(conn, "ism_mfg", "ISM Manufacturing PMI", "ISM release (via PR Newswire)", "Monthly (first business day)",
              "Above 52 and rising = growth acceleration. Below 48 = contraction.", "ISM_MFG", mfg, "index", "Manufacturing")
    s = _base(conn, "ism_svc", "ISM Services PMI", "ISM release (via PR Newswire)", "Monthly (third business day)",
              "Both PMIs above 50 and accelerating = growth regime. Both below 50 = contraction. Manufacturing below 50"
              " with services above 50 = mixed, uncertain regime; cut position count.", "ISM_SVC", svc, "index", "Services")
    m["levels"] = [{"value": 52, "label": "Acceleration"}, {"value": 50, "label": "Expansion"}, {"value": 48, "label": "Contraction"}]
    s["series"].append(_line("Manufacturing", mfg, "index"))
    s["levels"] = [{"value": 50, "label": "Expansion"}]
    m["rule_used"] = "Rising = higher than the month before."
    s["rule_used"] = "Accelerating = both higher than the month before."
    if len(mfg) >= 2:
        v, prev = mfg[-1][1], mfg[-2][1]
        m["lines"] = [{"label": "Month before", "value": prev, "unit": "index"},
                      {"label": "Change", "value": v - prev, "unit": "pts"}]
        if v > 52 and v > prev:
            m.update(reading="Above 52 and rising", tone="pos", points_to=["growth_up"])
        elif v < 48:
            m.update(reading="Below 48", tone="neg", points_to=["growth_down"])
        else:
            m.update(reading=("Expanding" if v >= 50 else "Contracting") + (", rising" if v > prev else ", falling"),
                     tone="ink")
    if len(svc) >= 2 and len(mfg) >= 2:
        v, prev, mv, mprev = svc[-1][1], svc[-2][1], mfg[-1][1], mfg[-2][1]
        s["lines"] = [{"label": "Month before", "value": prev, "unit": "index"},
                      {"label": "Manufacturing", "value": mv, "unit": "index"}]
        if mfg[-1][0] != svc[-1][0]:
            s["notes"].append("Manufacturing is a month ahead; services for that month comes out two business days later.")
        if v > 50 and mv > 50 and v > prev and mv > mprev:
            s.update(reading="Both above 50, accelerating", tone="pos", points_to=["growth_up"])
        elif v < 50 and mv < 50:
            s.update(reading="Both below 50", tone="neg", points_to=["growth_down"])
        elif mv < 50 <= v:
            s.update(reading="Diverging: manufacturing below 50", tone="warn", points_to=["uncertain"])
        else:
            s.update(reading="Both above 50, not both accelerating" if v > 50 and mv > 50 else "Mixed", tone="ink")
    return [m, s]


def _vix_signal(conn, xs: list[tuple[str, float]]) -> dict:
    s = _base(conn, "vix", "VIX level and trend", "CBOE (15-minute delayed)", "Daily, live in market hours",
              "VIX < 15 and falling = stable. VIX > 25 or rising > 30% = risk-off. VIX 20 or above"
              " = caution.", "VIX", xs, "index", "VIX")
    s["levels"] = [{"value": 25, "label": "Risk-off"}, {"value": 20, "label": "Caution"}, {"value": 15, "label": "Stable"}]
    s["rule_used"] = "Falling or rising = change over 5 sessions."
    if len(xs) < 6:
        return s
    v, chg = xs[-1][1], xs[-1][1] / _back(xs, 5) - 1
    s["lines"] = [{"label": "5-session change", "value": chg * 100, "unit": "pct_chg"}]
    if v > 25 or chg > 0.30:
        s.update(reading="Above 25" if v > 25 else "Up over 30%", tone="neg", points_to=["risk_off"])
    elif v >= 20:
        s.update(reading="Above 20", tone="warn")  # caution: amber, -0.5 in the regime score
    elif v < 15 and chg < 0:
        s.update(reading="Below 15 and falling", tone="pos", points_to=["growth_up"])
    else:
        s.update(reading="Between", tone="ink")
    return s


def evaluate(conn) -> dict:
    vix = _series(conn, "VIX")
    # page order, two per row: curves, credit, liquidity beside VIX, then the two ISMs
    signals = [*_curve(conn), *_credit(conn, vix), _liquidity(conn), _vix_signal(conn, vix), *_ism_signals(conn)]
    votes = {k: [s["key"] for s in signals if k in s["points_to"]] for k in REGIMES}
    return {"signals": signals, "votes": votes, "regimes": REGIMES, "score": _score(signals)}


# the five signals. each pair is one signal; its halves are averaged.
FAMILIES = [
    ("curve", "Yield curve", [("curve", "2s10s"), ("curve_3m", "3m10y")]),
    ("credit", "Credit spreads", [("credit", "HY"), ("credit_ig", "IG")]),
    ("liquidity", "TREAST + TGA", [("liquidity", "")]),
    ("ism", "ISM PMI", [("ism_mfg", "Manufacturing"), ("ism_svc", "Services")]),
    ("vix", "VIX", [("vix", "")]),
]
TONE_POINTS = {"pos": 1.0, "ink": 0.0, "warn": -0.5, "neg": -1.0}
SCORE_BAND = 30


def _score(signals: list[dict]) -> dict:
    """a mechanical risk score. each reading scores its colour (green +1, grey 0, amber -0.5, red -1); a pair's
    two readings are averaged into one signal; the five signals are weighted equally and scaled to -100..+100.
    +30 or more is risk-on, -30 or less risk-off, between is neutral. readings not available yet are left out of
    their average."""
    by_key = {s["key"]: s for s in signals}
    parts = []
    for key, title, members in FAMILIES:
        got = [{"key": k, "label": label, "reading": by_key[k]["reading"], "points": TONE_POINTS[by_key[k]["tone"]]}
               for k, label in members if k in by_key and by_key[k]["reading"] is not None]
        if got:
            parts.append({"key": key, "title": title, "points": sum(m["points"] for m in got) / len(got), "members": got})
    if not parts:
        return {"value": None, "label": None, "parts": [], "band": SCORE_BAND}
    value = round(sum(p["points"] for p in parts) / len(parts) * 100)
    label = "Risk-on" if value >= SCORE_BAND else "Risk-off" if value <= -SCORE_BAND else "Neutral"
    return {"value": value, "label": label, "parts": parts, "band": SCORE_BAND}
