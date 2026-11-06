import { useMemo, useState } from 'react'
import { Bars } from '../charts/Bars'
import { CompareChart } from '../charts/CompareChart'
import type { AccountDay } from '../lib/api'
import { date, dateYear, money, pct, signedMoney, tone } from '../lib/format'
import { Heading, Segmented } from './ui'

type Range = '1W' | 'MTD' | '1M' | '3M' | 'YTD' | 'ALL'
const RANGES: { value: Range; label: string }[] = [
  { value: '1W', label: '1W' },
  { value: 'MTD', label: 'MTD' },
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
  { value: 'YTD', label: 'YTD' },
  { value: 'ALL', label: 'All' },
]

/** First date inside the window, as YYYY-MM-DD; null means everything. */
function windowStart(range: Range, last: string): string | null {
  const d = new Date(`${last}T12:00:00Z`)
  if (range === 'ALL') return null
  if (range === 'YTD') return `${d.getUTCFullYear()}-01-01`
  if (range === 'MTD') return `${last.slice(0, 7)}-01`
  if (range === '1W') d.setUTCDate(d.getUTCDate() - 7)
  if (range === '1M') d.setUTCMonth(d.getUTCMonth() - 1)
  if (range === '3M') d.setUTCMonth(d.getUTCMonth() - 3)
  return d.toISOString().slice(0, 10)
}

/** Days in the window plus the prior close, which is the baseline for returns and the first bar. */
function slice(days: AccountDay[], range: Range): AccountDay[] {
  const last = days[days.length - 1]?.date
  const from = last ? windowStart(range, last) : null
  if (!from) return days
  const i = days.findIndex((d) => d.date >= from)
  return i < 0 ? days.slice(-2) : days.slice(Math.max(0, i - 1))
}

const pctAxis = (v: number) =>
  `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(Math.abs(v) < 0.1 && v !== 0 ? 1 : 0)}%`
const compact = (v: number) =>
  Math.abs(v) >= 1000 ? `${v < 0 ? '−' : ''}$${(Math.abs(v) / 1000).toFixed(1)}k` : money(v)

type Unit = 'pct' | 'usd'

export function AccountPanel({ days }: { days: AccountDay[] }) {
  const [range, setRange] = useState<Range>('ALL')
  const [unit, setUnit] = useState<Unit>('pct')

  const view = useMemo(() => slice(days, range), [days, range])
  const bars = useMemo(() => slice(days, 'MTD'), [days])

  if (view.length < 2) {
    const only = days[days.length - 1]
    if (!only) return null
    return (
      <section className="panel panel-cut flex flex-col p-5 md:p-6" aria-labelledby="acct-h">
        <h2 id="acct-h" className="text-[13px] font-medium text-ink-2">Net liquidation value</h2>
        <p className="num mt-2 text-4xl tracking-[-0.03em] text-ink md:text-[44px]">{money(only.net_liquidation, 2)}</p>
        <p className="mt-2 text-sm text-ink-3">
          Unrealized <span className={`num ${tone(only.unrealized_pnl)}`}>{signedMoney(only.unrealized_pnl, 2)}</span>
        </p>
        <div className="mt-6 flex flex-1 flex-col items-center justify-center rounded-[var(--radius-md)] border border-dashed border-line-strong px-5 py-10 text-center">
          <p className="text-sm text-ink-2">Account history starts on {dateYear(only.date)}.</p>
          <p className="mx-auto mt-1 max-w-[52ch] text-xs text-ink-3">
            IBKR doesn't give past daily account values through TWS. The return chart against SPY and the MTD
            breakdown fill in as each day's value is recorded by the sync.
          </p>
        </div>
      </section>
    )
  }
  const first = view[0]
  const last = view[view.length - 1]
  const change = last.net_liquidation - first.net_liquidation
  const ret = view.map((d) => d.net_liquidation / first.net_liquidation - 1)
  const spyBase = view.find((d) => d.spy != null)?.spy ?? null
  const spyRet = view.map((d) => (d.spy != null && spyBase ? d.spy / spyBase - 1 : null))
  const lastSpy = [...spyRet].reverse().find((v) => v != null) ?? null
  const lastRet = ret[ret.length - 1]
  const excess = lastSpy == null ? null : lastRet - lastSpy
  // dollar view: the account's value, and what the same starting money would be worth in SPY
  const values = view.map((d) => d.net_liquidation)
  const spyValues = spyRet.map((r) => (r == null ? null : first.net_liquidation * (1 + r)))
  const lastSpyValue = [...spyValues].reverse().find((v) => v != null) ?? null
  const daily = bars.slice(1).map((d, i) => d.net_liquidation - bars[i].net_liquidation)
  const mtd = daily.reduce((a, v) => a + v, 0)

  return (
    <section className="panel panel-cut p-5 md:p-6" aria-labelledby="acct-h">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="acct-h" className="text-[13px] font-medium text-ink-2">Net liquidation value</h2>
          <p className="num mt-2 text-4xl tracking-[-0.03em] text-ink md:text-[44px]">{money(last.net_liquidation, 2)}</p>
          <p className="mt-2 text-sm">
            <span className={`num ${tone(change)}`}>{signedMoney(change)}</span>
            <span className={`num ml-2 ${tone(change)}`}>{pct(lastRet, 1, true)}</span>
            <span className="ml-2 text-ink-3">since {dateYear(first.date)}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Unit> label="Chart units" value={unit} onChange={setUnit}
            options={[{ value: 'pct', label: '%' }, { value: 'usd', label: '$' }]} />
          <Segmented<Range> label="Time range" value={range} options={RANGES} onChange={setRange} />
        </div>
      </div>

      <div className="mt-6">
        <CompareChart
          ariaLabel={unit === 'pct' ? 'Account return compared with SPY' : 'Account value compared with the same money in SPY'}
          main={unit === 'pct' ? ret : values}
          bench={unit === 'pct' ? spyRet : spyValues}
          yFormat={unit === 'pct' ? pctAxis : compact}
          includeZero={unit === 'pct'}
          xLabel={(i) => date(view[i].date)}
          tooltip={(i) => (
            <div className="space-y-1.5">
              <div className="text-ink-3">{dateYear(view[i].date)}</div>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-ink-2">Account</span>
                <span className="num text-ink">{money(values[i], 2)}</span>
              </div>
              <div className="flex justify-end gap-3 text-ink-3">
                <span className={`num ${tone(values[i] - first.net_liquidation)}`}>{signedMoney(values[i] - first.net_liquidation)}</span>
                <span className={`num ${tone(ret[i])}`}>{pct(ret[i], 2, true)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-t border-line pt-1.5">
                <span className="text-ink-2">Same in SPY</span>
                <span className="num text-ink-2">{money(spyValues[i], 2)}</span>
              </div>
              <div className="flex justify-end text-ink-3">
                <span className={`num ${tone(spyRet[i])}`}>{pct(spyRet[i], 2, true)}</span>
              </div>
            </div>
          )}
        />
      </div>

      <ul className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]" aria-label="Legend">
        <li className="flex items-center gap-2">
          <span aria-hidden className="h-0.5 w-5 rounded-full bg-ink" />
          <span className="text-ink-2">Account</span>
          <span className="num text-ink">{money(last.net_liquidation)}</span>
          <span className={`num ${tone(lastRet)}`}>{pct(lastRet, 1, true)}</span>
        </li>
        <li className="flex items-center gap-2">
          <svg aria-hidden width="20" height="2">
            <line x1="1" x2="19" y1="1" y2="1" stroke="var(--color-ink-3)" strokeWidth="1.5"
              strokeDasharray="1.5 3.5" strokeLinecap="round" />
          </svg>
          <span className="text-ink-2">Same money in SPY</span>
          <span className="num text-ink">{money(lastSpyValue)}</span>
          <span className={`num ${tone(lastSpy)}`}>{pct(lastSpy, 1, true)}</span>
        </li>
        {excess != null && (
          <li className="text-ink-3">
            {excess >= 0 ? 'Ahead of SPY by ' : 'Behind SPY by '}
            <span className="num text-ink-2">{(Math.abs(excess) * 100).toFixed(1)} pts</span>
            {lastSpyValue != null && <span className="num text-ink-2"> ({money(Math.abs(last.net_liquidation - lastSpyValue))})</span>}
          </li>
        )}
      </ul>

      <div className="mt-6 border-t border-line pt-5">
        <Heading right={<span className={`num text-xs ${tone(mtd)}`}>{signedMoney(mtd)} this month</span>}>
          MTD breakdown
        </Heading>
        <div className="mt-3">
          <Bars
            ariaLabel="Daily change in account value, month to date"
            height={120}
            values={daily}
            yFormat={compact}
            xLabel={(i) => date(bars[i + 1].date)}
            tooltip={(i) => (
              <div className="space-y-1">
                <div className="text-ink-3">{dateYear(bars[i + 1].date)}</div>
                <div className={`num text-sm ${tone(daily[i])}`}>{signedMoney(daily[i])}</div>
                <div className="text-ink-3">
                  Realized <span className="num text-ink-2">{signedMoney(bars[i + 1].realized_pnl)}</span>
                </div>
              </div>
            )}
          />
        </div>
      </div>
    </section>
  )
}
