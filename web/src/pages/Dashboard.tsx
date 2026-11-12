import { useEffect, useRef, useState } from 'react'
import { AccountPanel, slice, type Range } from '../components/AccountPanel'
import { CostsPanel } from '../components/CostsPanel'
import { StatsPanel } from '../components/StatsPanel'
import { StrategyHeatmap } from '../components/StrategyHeatmap'
import { TradesTable } from '../components/TradesTable'
import { Heading } from '../components/ui'
import { api, type AccountDay, type Costs, type Summary, type TradeRow } from '../lib/api'
import { navigate } from '../lib/router'

const RECENT = 10
const RANGE_KEYS: Range[] = ['1W', 'MTD', '1M', '3M', 'YTD']

export function Dashboard({ trades, summary, account, costs, selected, onOpen }: {
  trades: TradeRow[]
  summary: Summary
  account: AccountDay[]
  costs: Costs
  selected: number | null
  onOpen: (id: number, order: number[]) => void
}) {
  // API returns newest first
  const recent = trades.slice(0, RECENT)
  // the stats follow the account panel's time range: from the close before the range starts
  const [range, setRange] = useState<Range>('ALL')
  const since = range === 'ALL' ? undefined : slice(account, range)[0]?.date
  // every range's stats are fetched up front, so switching ranges swaps the numbers at once instead of
  // showing all-time stats for a moment while the request is out
  const [bySince, setBySince] = useState<Record<string, Summary>>({})
  useEffect(() => {
    let live = true
    const sinces = [...new Set(RANGE_KEYS.map((r) => slice(account, r)[0]?.date).filter((d): d is string => !!d))]
    Promise.all(sinces.map((d) => api.summary(d).then((s) => [d, s] as const)))
      .then((pairs) => { if (live) setBySince(Object.fromEntries(pairs)) })
      .catch(() => {})
    return () => { live = false }
  }, [account, summary])
  // until a range's numbers arrive, keep showing whatever was on screen
  const shown = useRef(summary)
  const stats = !since ? summary : bySince[since] ?? shown.current
  shown.current = stats

  return (
    <>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <AccountPanel days={account} range={range} onRange={setRange} />
        <StatsPanel s={stats} />
      </div>

      <section aria-labelledby="recent-h">
        <Heading><span id="recent-h">Recent trades</span></Heading>
        <div className="mt-3">
          <TradesTable trades={recent} selected={selected} onOpen={onOpen} emptyText="No trades yet." />
        </div>
        {trades.length > RECENT && (
          <div className="mt-3 flex justify-center">
            <a href="/journal"
              onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate('/journal'); window.scrollTo({ top: 0 }) }}
              className="inline-flex h-8 items-center rounded-[var(--radius-md)] border border-line-strong px-4 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink active:translate-y-px">
              Show all
            </a>
          </div>
        )}
      </section>

      <CostsPanel costs={costs} fees={summary.fees} />

      <StrategyHeatmap trades={trades} />
    </>
  )
}
