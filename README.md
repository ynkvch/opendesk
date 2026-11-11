# opendesk

The first open-sourced derivatives desk. One app for an options trader's whole day: the journal, the book's
risk, the macro regime, options flow and volatility. It runs on your own machine, reads your own broker
account (Interactive Brokers today) and uses your own data keys. There is no subscription.

## What it does today

- **Options journal.** Every trade from your fills, with P&L path, MAE/MFE, R multiple, fees, payoff at expiry
  and now, Greeks and IV at entry and exit, legs, executions, and a time value and theta panel for single-leg
  options. You write the thesis and post-mortem; the app never does.
- **Account.** Net liquidation value against the same money in SPY, Sharpe ratio, max drawdown, beta and alpha
  against SPY, profit factor, expectancy, and everything trading has cost you.
- **Macro regime.** Six signals (yield curve, credit spreads, Fed balance sheet and Treasury cash, ISM, VIX),
  each read with its own rule, routed to the sectors and options approach each regime favours.
- **Sector rotation.** The 11 sector ETFs on a relative rotation graph against SPY or QQQ.
- **Flow and volatility.** Any ticker's option chain from TWS, read every minute: call and put premium today
  across the whole chain, flow by strike, the last five sessions of flow against the share price, the most traded
  contracts, then implied against realized vol, skew at 30/60/90 days, the term structure and the 30-60 day
  forward factor.

## Planned

opendesk is early. These are next, in roughly this order:

- **In-depth risk management.** Book-level Greeks across every open position, scenario and stress tests (spot,
  vol and time shocks), risk limits and position sizing, and alerts when the book drifts outside them.
- **Options flow screening.** Unusual activity across a watchlist rather than one ticker at a time: large and
  sweep orders, volume against open interest, and alerts when premium piles into one side.
- **Deeper volatility analytics.** Full IV surfaces, expected moves and earnings moves, the volatility cone,
  risk reversals and butterflies, spot-vol beta, and dealer gamma exposure.
- **Customisable regime.** Choose your own indicators, rules and weights for the regime score.
- **More brokers and data sources,** each connected with your own API keys.

Ideas and contributions are welcome: open an issue.

## Try it with demo data

```bash
pip install -r requirements.txt
./run.sh
```

Then open http://localhost:5173.

The first run builds a demo account with `server/demo.py`: $19,000 from 2 June to 4 November 2026, fourteen
closed option trades, ending at $25,412.80. It is the same account shown on [opendesk.bid](https://opendesk.bid).
Trades are priced with Black-Scholes on real daily prices (`server/demo_data.json`); the regime readings are made
up. A "Demo data" badge shows in the top bar while you are looking at it.

Rebuild the demo at any time with `python3 -m server.demo`.

The Flow tab reads live option chains from TWS. To see it without TWS, start with `VOL_SOURCE=sim ./run.sh`
instead, which feeds it a made-up chain.

Requirements: Python 3.11+, Node 20+.

## Use your own account

Everything personal lives in `data/`, which git ignores: the databases, logs and your keys.

1. Delete the demo databases: `rm data/journal.db data/signals.db`.
2. Copy `keys.example.json` to `data/keys.json` and fill in what you use (see below).
3. Import your history with Flex, and keep it current with TWS.

| Source | Gives | Needs |
|---|---|---|
| Flex | Every fill with commission and realized P&L, cash transactions, daily account value | `ibkr_flex_token` and `ibkr_flex_query_id` in `data/keys.json` |
| TWS | Today's fills, live marks, hourly P&L path, session closes, entry IV and Greeks | TWS open and logged in, API on port 7496 (read-only) |

The TWS API only returns the current day's fills, so Flex is the source for history.

The Flex token comes from Client Portal > Performance & Reports > Flex Queries > Flex Web Service Configuration.
The query ID belongs to an Activity Flex Query (XML) with Trades, Open Positions, Prior Period Positions, Cash
Transactions, Option Exercises/Assignments/Expirations and Net Asset Value.

```bash
python3 -m server.flex --days 30          # download and import the last 30 days
python3 -m server.flex --file report.xml  # import a saved report
python3 -m server.sync_tws                # TWS sync now
```

## Keys

`data/keys.json` (start from `keys.example.json`). For the FRED key, the environment variable `FRED_API_KEY` wins
over the file.

| Key | Used by | Where to get it |
|---|---|---|
| `ibkr_flex_token`, `ibkr_flex_query_id` | Trade history | IBKR Client Portal, see above |
| `fred_api_key` | Regime page | Free at fredaccount.stlouisfed.org > API Keys |

## Pages

**Dashboard and Journal.** Account value against SPY, closed-trade stats, recent trades, costs, and a strategy
heatmap. Click a trade for its full breakdown.

**Regime (`/regime`).** Six macro signals, each read with its own rule: the 2s10s and 3m10y curves, HY and IG
credit spreads, Fed balance sheet plus Treasury cash (TREAST + TGA), ISM manufacturing and services, and VIX.
Each points to a regime (growth, risk-off, liquidity and so on), and the page routes regimes to sectors. Data
comes from FRED, the Treasury's daily yield curve, CBOE and ISM releases, collected by
`server/signals/regime.py` into `data/signals.db`. Needs `fred_api_key`.

**Sectors (`/regime/sectors`).** The 11 Select Sector SPDR ETFs against SPY or QQQ on a relative rotation graph
(an open approximation of RRG: `web/src/lib/rrg.ts`), plus gold, β-adjusted gaps and one chart per sector.
Prices come from Yahoo Finance's chart API with no key; a page read that finds them over 15 minutes old fetches
fresh ones in the background.

**Flow (`/flow`).** Type a ticker and the page reads its option chain from TWS every minute while it's open, and in
market hours it keeps recording the last ticker opened whenever TWS is running. The strikes near the money are read
every minute and the rest of the chain in rotation, so the premium totals reach every contract that traded within a
few minutes. The flow chart uses TWS's 5-minute trade bars for each contract, today's and the last five sessions',
with premium as each bar's volume × its average traded price × 100; it can also show 15 or 30 minutes. The bars
come from IBKR's servers whenever TWS is open, so missed sessions are filled in later. A ticker's first build reads
one contract at a time and takes several minutes. TWS keeps no history of an option chain, so skew and
forward-factor history is built from one snapshot a day, stored in `data/vol.db`. Needs TWS open with the API
enabled, and options market data for the ticker. To try the page without TWS, run
`VOL_SOURCE=sim ./run.sh`: a made-up chain, kept in its own `data/vol_sim.db`.

**Time value and theta.** For single-leg options the trade page shows extrinsic value at each session close,
theta per day, and a projection to expiry with the underlying and IV held where they closed.

## Layout

| Path | What it is |
|---|---|
| `server/db.py` | SQLite schema: `trades`, `legs`, `fills`, `marks`, `option_daily`, `account_daily`, `benchmark_daily`, `ib_trades`, `cash_transactions` |
| `server/api.py` | FastAPI: `/api/trades`, `/api/trades/{id}`, `/api/trades/{id}/theta`, `/api/summary`, `/api/account`, `/api/costs`, `PATCH /api/trades/{id}/notes` |
| `server/demo.py` | Demo account generator, with its prices in `server/demo_data.json` |
| `server/flex.py` | Imports IBKR Flex reports: fills, commissions, cash transactions, daily account value |
| `server/sync_tws.py` | Read-only TWS sync: today's fills, account value, SPY closes, entry IV and Greeks, marks for open trades |
| `server/fills.py` | Turns fills into trades: buys average into one position, which closes when everything is sold |
| `server/journal_job.py` | Scheduled run of Flex and TWS |
| `server/greeks_at_entry.py` | Greeks at the moment of a fill: IBKR's model next to this project's Black-Scholes |
| `server/bs.py` | Black-Scholes price, Greeks and implied vol |
| `server/vol.py` | The Flow page: reads option chains from TWS, keeps snapshots, open interest and trade bars in `data/vol.db` |
| `server/signals/` | The Regime page's collector (`regime.py`, run by `run.py`) and the sector prices (`sectors.py`), with `config.json` for their settings |
| `web/` | React + Vite + Tailwind UI |
| `scripts/` | macOS launchd jobs for running things on a schedule |
| `data/` | Your databases, logs and keys. Ignored by git |

Collect the regime readings by hand with `python3 -m server.signals.run`.

## Run it in the background (macOS)

The files in `scripts/` are launchd jobs. Fill in this folder and your Python, then load one:

```bash
job=com.opendesk.api   # or com.opendesk.journal, com.opendesk.regime
sed -e "s|__OPENDESK__|$PWD|g" -e "s|__PYTHON__|$(command -v python3)|g" scripts/$job.plist > ~/Library/LaunchAgents/$job.plist
launchctl load ~/Library/LaunchAgents/$job.plist
```

| Job | What it does |
|---|---|
| `com.opendesk.api` | Keeps the API and the built UI (`cd web && npm run build`) up at http://localhost:8000 |
| `com.opendesk.journal` | Every 15 minutes: Flex once a day, TWS during US trading hours if TWS is open |
| `com.opendesk.regime` | Collects regime data every 15 minutes on weekdays |

Output goes to `data/*.log`.

## Journal rules built in

- Trades never get a generated thesis or post-mortem. Those fields are yours.
