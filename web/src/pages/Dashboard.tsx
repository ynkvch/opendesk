import { AccountPanel } from '../components/AccountPanel'
import { CostsPanel } from '../components/CostsPanel'
import { StatsPanel } from '../components/StatsPanel'
import { StrategyHeatmap } from '../components/StrategyHeatmap'
import { TradesTable } from '../components/TradesTable'
import { Heading } from '../components/ui'
import type { AccountDay, Costs, Summary, TradeRow } from '../lib/api'
import { navigate } from '../lib/router'

const RECENT = 10

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

  return (
    <>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <AccountPanel days={account} />
        <StatsPanel s={summary} />
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
