# Filings and data: sources, collectors and ideas

Written on 2 October 2026, when these sources had their own page at `/data`. That page has since been removed;
the collectors in `server/signals/` still work and write to `data/signals.db`.

---

## 1. What the page does

Three tabs. **Industry data** opens first.

| Tab | Shows |
|---|---|
| **Industry data** | Monthly trade figures for AI hardware by country. Each card has the latest value, the change from a year earlier and from the month before, a sparkline, the firms behind the number, and a freshness colour. Clicking a card replaces its section with that figure's detail (description, source, plain-English summary, two charts); the X brings the section back. |
| **Activity** | A plain-language feed of what happened to the covered companies: 8-K events with the filing's own text, financial reports with revenue against a year earlier, company agreements (other party and stated value, read by Claude), and federal contracts. "Significant" or "Everything". |
| **Documents** | SEC filings, company agreements and federal contracts as tables. Each shows 10 rows and "Show more"; the full view has an X to go back. |

**Settings** (top right) picks which of the 12 covered companies appear under Activity and Documents. The
choice is remembered in the browser.

**Freshness colours.** The key sits above the source chips.
- Source chips: green when collected on schedule; amber when overdue; red when well overdue or the last run failed.
- Card dates: green when the latest figure is as recent as that source normally allows; amber one month later than
  usual; red two or more months late. Series more than 4 months old are hidden.

---

## 2. Covered companies

NVDA, INTC, ASML, AMD, ARM, META, MU, MRVL, SMCI, SNDK, TSM, QCOM (`watchlist` in `config.json`).

---

## 3. Data sources

| Source | What | Normal delay | Key | Status |
|---|---|---|---|---|
| **SEC EDGAR** | 8-K (with item text), 6-K, 10-Q/10-K/20-F, 13D/13G, NT filings, S-3; quarterly revenue and net income (XBRL); other companies' 8-K agreements that name a covered company (full-text search) | Same day | `sec_user_agent` | Working |
| **Taiwan monthly exports** | Ministry of Finance English PDF: chips (electronic components), servers/ICT, to the US, to China + HK, total | ~8th of next month | none | Working, 25 months |
| **Taiwan export orders** | Ministry of Economic Affairs: totals from its release pages; product and region split from the workbook you download, and Focus Taiwan for new months | ~20th of next month | none | Working, 18 months |
| **South Korea monthly exports** | Trade ministry English release: semiconductors, computers (SSDs), to China, to the US, total | 1st of next month | none | Working, 24 months |
| **South Korea preliminary exports** | Customs figures for the 1st–10th and 1st–20th, via Yonhap's English feed | ~11th and ~21st | none | Working; history builds from Sep 2026 |
| **United States** | UN Comtrade: chip and chipmaking-equipment exports; computer/server, parts and chip imports from Taiwan | ~3 months | `comtrade_key` | Working, 24 months |
| **Japan** | Japan Customs on e-Stat: chipmaking equipment, chips, memory chips; summed across destinations, yen converted at the Fed's monthly rate | ~3 weeks | `estat_app_id` (+ `fred_api_key` for the rate) | Working, Jan 2024 – Aug 2026 |
| **US industry (FRED)** | Chip production, capacity use, chip producer prices, electronics orders/shipments/inventories, computer shipments | ~6 weeks | `fred_api_key` | Working |
| **Federal contracts** | USASpending.gov contract actions for covered US companies | Daily (defense up to 90 days late) | none | Working; few rows — chipmakers rarely contract directly |

Keys live in `data/keys.json` (local only, never committed):
`sec_user_agent`, `fred_api_key`, `comtrade_key`, `census_key`, `estat_app_id`.

---

## 4. Where Claude is used

All through the Claude Code CLI on your subscription (`server/signals/claude_cli.py`): no API key, all tools
disabled (`--tools ""`), customizations off (`--safe-mode`), answers forced into a JSON schema, and source text
passed as data only. Each item is read once and cached.

| Job | File | Model | Volume |
|---|---|---|---|
| Who an agreement is with, its stated value, whether the covered company is a party, a one-line summary | `deals_ai.py` | Haiku, 8 filings per call | 101 checked so far (57 real deals); new ones a few per week |
| Reading Taiwan's and Korea's monthly releases, Taiwan export orders and Korea's preliminary reports | `trade.py` | Haiku, one release per call | ~4–6 calls a month |

Each value Claude reads is shown with the sentence it came from (agreements) or the source link (releases), so it
can be checked.

---

## 5. Firms behind each statistic

Every series has its own "Who's behind it" note (`trade.firms` in `config.json`), e.g.
- Korean semiconductor exports — Samsung Electronics and SK Hynix.
- Korean computer exports — SSDs from Samsung and SK Hynix.
- Taiwan ICT orders from the US — servers Foxconn, Quanta, Wistron, Wiwynn and Inventec build for NVIDIA, Dell,
  HPE, Supermicro and the cloud companies.
- Japan chipmaking equipment — Tokyo Electron, Screen, Kokusai, Advantest, Disco, Lasertec, Canon, Nikon.

Edit the config to change them; the page picks it up on reload.

---

## 6. How to run and collect

```bash
./run.sh                                     # dashboard: API :8000, UI :5173
python3 -m server.signals.run                # collect every source now
python3 -m server.signals.run sec trade      # some sources
python3 -m server.signals.run --due          # only sources whose release window is open (for the schedule)
```

Schedule (in `config.json`): SEC every 15 min on US weekdays; FRED hourly 08:00–12:00 ET; federal contracts daily;
trade every 6 hours. `scripts/com.opendesk.signals.plist` runs `--due` every 15 minutes once installed (see the README).

**Taiwan export-order history:** download "新聞稿全部附表(ODS/EXCEL)" from the
[ministry's release page](https://www.moea.gov.tw/Mns/dos/bulletin/Bulletin.aspx?kind=5&html=1&menu_id=6724) into
`data/`. The importer loads the newest `*附表*.xlsx` once.

---

## 7. Suggested, not built

| Idea | What it adds | Notes |
|---|---|---|
| Replace "vs the month before" with the 3-month trend on non-seasonally-adjusted cards | Monthly change in trade data is mostly calendar noise; year-over-year and its 3-month average are reliable | Keep month-over-month on FRED cards, which are seasonally adjusted |
| Switch the US to the Census Bureau | About a month fresher | Waiting on the key |
| Korea chip production, shipments and inventories (Statistics Korea) | Inventories rising faster than shipments means supply outrunning demand | Monthly, end of month; access not yet checked |
| Japan chipmaking-equipment sales (SEAJ) | Fab building 6–12 months ahead | Monthly; access not yet checked |
| Worldwide chip sales (SIA / WSTS) | Broadest single demand gauge | Monthly; access not yet checked |
| Malaysia electrical & electronics exports (statistics department release, read by Claude) | Faster than Comtrade, but broader than chips | Optional |
| Hyperscaler capex (Microsoft, Google, Amazon, Meta, Oracle) from SEC XBRL | Where AI hardware demand starts | Quarterly; would extend the SEC collector |
| US export-control rules (Federal Register API) | Entity List and chip-rule changes | Free, no key |
| Memory spot prices (TrendForce) | Price side of memory supply/demand | Manual entry; no free API |
| Refresh the Taiwan export-order workbook now and then | Fills any month Focus Taiwan misses | Same download as §6 |

---

## 8. Reference notes

- **Why Comtrade is ~3 months behind:** each country publishes its own figures first (3–6 weeks), then sends them to
  the UN, which validates and loads them in batches. National sources are faster where they exist.
- **Year-over-year vs month-over-month:** trade and order figures aren't seasonally adjusted, so monthly changes mix
  real change with Lunar New Year, working days and quarter-end effects. Year-over-year cancels those; watch its
  3-month average for the trend. Beware a weak base month inflating the percentage.
- **Malaysia and Intel/AMD:** Intel's largest assembly and test sites outside the US are in Penang and Kulim; AMD chips
  are assembled and tested in Penang at TF-AMD (controlled by Tongfu Microelectronics; AMD holds 15%). Their output
  counts as Malaysian processor exports.

---

## 9. Code map

| Path | Role |
|---|---|
| `server/signals/run.py` | Runs collectors, `--due` schedule logic, records runs |
| `server/signals/sec.py` | SEC filings, 8-K text, XBRL financials, agreement search |
| `server/signals/trade.py` | Comtrade, Japan e-Stat, Taiwan/Korea releases, Taiwan orders (feed + workbook), Korea preliminary |
| `server/signals/fred.py`, `usaspending.py` | FRED series; federal contracts |
| `server/signals/claude_cli.py`, `deals_ai.py` | Claude calls; agreement checking |
| `server/signals/extract.py` | Rule-based party/amount reading (fallback before Claude checks) |
| `server/signals/activity.py` | Activity feed sentences and agreement rows |
| `server/signals/flags.py` | Flags: unusual year-over-year moves, 8-K items, large contracts |
| `server/signals/routes.py` | API under `/api/signals/*`, freshness rules, section order |
| `server/signals/store.py` | SQLite schema (`data/signals.db`) |
| `server/signals/config.json` | Watchlist, sources, firms, thresholds, schedule |
| `web/src/pages/FilingsData.tsx` | The page: tabs, settings, industry data, documents |
| `web/src/components/Activity.tsx` | Activity feed |
