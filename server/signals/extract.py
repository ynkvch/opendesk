"""Pull the other party, the stated amount and the covered company's role out of agreement text.

Rule-based, so it reads what the filing literally says: the first companies named next to the
agreement, the dollar amount in the sentence that talks about price or size, and whether the
covered company is named as a party (with, between, a defined term) or only mentioned.
"""
import re

SUFFIX = (r"(?:Inc\.?|Incorporated|Corporation|Corp\.?|LLC|L\.L\.C\.|Ltd\.?|Limited|N\.A\.|L\.P\.|LP|plc|PLC|AG|"
          r"N\.V\.|B\.V\.|S\.A\.|SE|GmbH|Co\.,? Ltd\.?|Company|Holdings)")
ORG_RE = re.compile(rf"((?:(?:[A-Z][\w&.\-’']*|&)\s+){{0,6}}[A-Z][\w&.\-’']*,?\s+{SUFFIX})(?![a-z])")
LEAD_WORDS = {"The", "On", "And", "With", "By", "Between", "Among", "Of", "To", "For", "In", "An", "A", "Each",
              "Under", "Pursuant", "Certain", "Its", "Our", "That", "This", "As", "Such", "Company", "Item"}
MONEY_RE = re.compile(r"(?:US)?\$\s?(\d[\d,]*(?:\.\d+)?)\s*(billion|million|thousand|bn|mm|m)?\b(?!\s*per\b)", re.I)
SCALE = {"billion": 1e9, "bn": 1e9, "million": 1e6, "mm": 1e6, "m": 1e6, "thousand": 1e3}
VALUE_WORDS = re.compile(r"purchase price|aggregate|total|principal amount|up to|consideration|commitment|valued|"
                         r"worth|in exchange for|approximately|facility|financing|investment|loan|notes|fee", re.I)
DEAL_WORDS = r"agreement|contract|lease|purchase|supply|licen[cs]e|collaborat|partner|order|guarant|customer|invest|" \
             r"acqui|merger|note|loan|facility|services|capacity"


def orgs(text: str) -> list[str]:
    out: list[str] = []
    for m in ORG_RE.finditer(text):
        found = m.group(1)
        # a match can run across a sentence end ("…Indenture. The Company, Barclays Capital Inc.")
        cut = [b.end() for b in re.finditer(r"[a-z]{3,}\.\s+", found)]
        words = found[cut[-1]:].split() if cut else found.split()
        while words and words[0].strip(",") in LEAD_WORDS:
            words.pop(0)
        name = " ".join(words).strip(" ,")
        if len(name) > 3 and name not in out:
            out.append(name)
    return out


def counterparties(text: str, exclude: list[str], limit: int = 3) -> list[str]:
    """Companies named in the text, minus the filer and its own subsidiaries (same first word)."""
    bases = {e.split()[0].lower().strip(",.") for e in exclude if e and e.split()}
    return [o for o in orgs(text) if o.split()[0].lower().strip(",.") not in bases][:limit]


def stated_amount(text: str) -> tuple[float, str] | None:
    """The largest dollar amount in the sentence most about price or size, with that sentence."""
    best: tuple[int, float, str] | None = None
    for sentence in re.split(r"(?<=[.;])\s+(?=[A-Z(“\"])", re.sub(r"\s+", " ", text)):
        amounts = []
        for m in MONEY_RE.finditer(sentence):
            v = float(m.group(1).replace(",", "")) * SCALE.get((m.group(2) or "").lower(), 1)
            if v >= 100_000:  # skips per-share prices and fees in single dollars
                amounts.append(v)
        if not amounts:
            continue
        score = len(VALUE_WORDS.findall(sentence))
        cand = (score, max(amounts), sentence.strip())
        if best is None or cand[:2] > best[:2]:
            best = cand
    if best is None:
        return None
    s = best[2]
    return best[1], (s if len(s) <= 300 else s[:297].rstrip() + "…")


CONTRACT_DOCS = re.compile(r"^(8-K|EX-10|EX-4|EX-2|EX-1\.)")


def contract_doc(doc_type: str | None) -> bool:
    """The 8-K itself or an exhibit that is an agreement; press releases and slides (EX-99) are not."""
    return bool(CONTRACT_DOCS.match(doc_type or ""))


def is_party(text: str, terms: list[str]) -> bool:
    """True when a covered company is a party to the deal, not just mentioned (a bio, a list of tenants)."""
    name = "|".join(re.escape(t) for t in terms)
    bio = rf"\b(?:positions?|roles?|served|serves|worked|works|held|career|former(?:ly)?|alumn\w*)\b[^.;]{{0,120}}(?:{name})"
    sentences = [x for x in re.split(r"(?<=[.;])\s+", text) if re.search(name, x, re.I)]
    text = " ".join(x for x in sentences if not re.search(bio, x, re.I))
    if not text:
        return False
    patterns = [
        rf"(?:{DEAL_WORDS})[^.;]{{0,80}}\bwith\s+(?:the\s+)?(?:{name})",
        rf"\bbetween\b[^.;]{{0,240}}(?:{name})",
        rf"\bamong\b[^.;]{{0,240}}(?:{name})",
        rf"(?:{name})[^.;]{{0,140}}\(\s*(?:the\s+)?[“\"]",                # defined as a party: Micron Technology, Inc. (“Micron”)
        rf"(?:{name})[^.;]{{0,80}}\b(?:agreed|will (?:supply|provide|purchase|invest|lease))",
        rf"[“\"][^”\"]{{0,40}}(?:Guarantor|Purchaser|Seller|Lender|Licensor|Licensee|Supplier|Customer|Investor|"
        rf"Tenant|Counterparty)\s*[”\"]\s*means\s+(?:{name})",
        rf"(?:{DEAL_WORDS})[^.;]{{0,60}}\b(?:from|to|by)\s+(?:{name})",
    ]
    return any(re.search(p, text, re.I) for p in patterns)
