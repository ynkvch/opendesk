import { Funnel, X } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import {
  ASSET_LABEL, EMPTY_FILTERS, FilterSheet, OUTCOME_LABEL, STATUS_LABEL, type Filters,
} from '../components/FilterSheet'
import { TradesTable } from '../components/TradesTable'
import type { TradeRow } from '../lib/api'
import { signedMoney, tone } from '../lib/format'

const BASE_STRATEGIES = ['Long call', 'Short call', 'Long put', 'Short put', 'Long stock', 'Short stock']

export function Journal({ trades, selected, onOpen }: {
  trades: TradeRow[]
  selected: number | null
  onOpen: (id: number, order: number[]) => void
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [sheet, setSheet] = useState(false)

  const symbols = useMemo(() => {
    const count = new Map<string, number>()
    trades.forEach((t) => count.set(t.underlying, (count.get(t.underlying) ?? 0) + 1))
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s)
  }, [trades])
  const strategies = useMemo(
    () => [...BASE_STRATEGIES, ...new Set(trades.map((t) => t.strategy).filter((s) => !BASE_STRATEGIES.includes(s)))],
    [trades])

  // within a group any selected value matches; across groups all must match
  const rows = useMemo(() => trades.filter((t) =>
    (!filters.assets.length || filters.assets.includes(t.asset)) &&
    (!filters.strategies.length || filters.strategies.includes(t.strategy)) &&
    (!filters.symbols.length || filters.symbols.includes(t.underlying)) &&
    (filters.status === 'all' || t.status === filters.status) &&
    (filters.outcome === 'all' || (filters.outcome === 'win' ? (t.pnl ?? 0) > 0 : (t.pnl ?? 0) < 0))),
  [trades, filters])

  const chips: { label: string; clear: () => void }[] = [
    ...filters.assets.map((a) => ({ label: ASSET_LABEL[a], clear: () => setFilters({ ...filters, assets: filters.assets.filter((x) => x !== a) }) })),
    ...filters.strategies.map((s) => ({ label: s, clear: () => setFilters({ ...filters, strategies: filters.strategies.filter((x) => x !== s) }) })),
    ...filters.symbols.map((s) => ({ label: s, clear: () => setFilters({ ...filters, symbols: filters.symbols.filter((x) => x !== s) }) })),
    ...(filters.status !== 'all' ? [{ label: STATUS_LABEL[filters.status], clear: () => setFilters({ ...filters, status: 'all' }) }] : []),
    ...(filters.outcome !== 'all' ? [{ label: OUTCOME_LABEL[filters.outcome], clear: () => setFilters({ ...filters, outcome: 'all' }) }] : []),
  ]
  const total = rows.reduce((a, t) => a + (t.pnl ?? 0), 0)

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">Journal</h1>
          <p className="mt-1 text-sm text-ink-3">
            <span className="num text-ink-2">{rows.length}</span> of <span className="num">{trades.length}</span> trades,
            {' '}P&L <span className={`num ${tone(total)}`}>{signedMoney(total)}</span>
          </p>
        </div>
        <button type="button" onClick={() => setSheet(true)} aria-haspopup="dialog"
          className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-md)] border border-line-strong px-3.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink active:translate-y-px">
          <Funnel size={15} aria-hidden />
          Filter
          {chips.length > 0 && (
            <span className="num grid h-5 min-w-5 place-items-center rounded-full bg-ink px-1.5 text-[11px] text-bg">{chips.length}</span>
          )}
        </button>
      </div>

      {chips.length > 0 && (
        <div className="-mt-6 flex flex-wrap items-center gap-1.5" aria-label="Active filters">
          {chips.map((c) => (
            <button key={c.label} type="button" onClick={c.clear} aria-label={`Remove filter ${c.label}`}
              className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] border border-line-strong bg-surface-2 pl-2.5 pr-1.5 text-xs text-ink hover:border-ink-3">
              {c.label}
              <X size={11} aria-hidden className="text-ink-3" />
            </button>
          ))}
          <button type="button" onClick={() => setFilters(EMPTY_FILTERS)}
            className="h-7 rounded-[var(--radius-sm)] px-2 text-xs text-ink-3 hover:text-ink">
            Clear all
          </button>
        </div>
      )}

      <TradesTable trades={rows} selected={selected} onOpen={onOpen} />

      <FilterSheet open={sheet} onClose={() => setSheet(false)} filters={filters} onChange={setFilters}
        strategies={strategies} symbols={symbols} matching={rows.length} />
    </>
  )
}
