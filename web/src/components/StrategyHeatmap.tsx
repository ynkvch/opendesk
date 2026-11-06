import { useMemo, useState } from 'react'
import type { TradeRow } from '../lib/api'
import { signedMoney, tone } from '../lib/format'
import { Heading, Segmented } from './ui'

type Dim = 'symbol' | 'dte' | 'iv'
const DIMS: { value: Dim; label: string }[] = [
  { value: 'symbol', label: 'Symbol' },
  { value: 'dte', label: 'DTE at entry' },
  { value: 'iv', label: 'IV rank at entry' },
]

const DTE_COLS = ['0-7 days', '8-21 days', '22+ days']
const IV_COLS = ['Low (0-33)', 'Mid (34-66)', 'High (67-100)']

function column(t: TradeRow, dim: Dim): string {
  if (dim === 'symbol') return t.underlying
  if (dim === 'dte') return t.dte_entry <= 7 ? DTE_COLS[0] : t.dte_entry <= 21 ? DTE_COLS[1] : DTE_COLS[2]
  const r = t.iv_rank_entry ?? 50
  return r < 34 ? IV_COLS[0] : r < 67 ? IV_COLS[1] : IV_COLS[2]
}

type Cell = { pnl: number; n: number; wins: number }
const countLabel = (n: number) => `${n} ${n === 1 ? 'trade' : 'trades'}`

const add = (c: Cell | undefined, pnl: number): Cell =>
  ({ pnl: (c?.pnl ?? 0) + pnl, n: (c?.n ?? 0) + 1, wins: (c?.wins ?? 0) + (pnl > 0 ? 1 : 0) })

/** Realized P&L by strategy against a second dimension. Colour intensity scales with size. */
export function StrategyHeatmap({ trades }: { trades: TradeRow[] }) {
  const [dim, setDim] = useState<Dim>('symbol')
  const closed = useMemo(() => trades.filter((t) => t.status === 'closed' && t.pnl != null), [trades])

  const grid = useMemo(() => {
    const cells = new Map<string, Map<string, Cell>>()
    const totals = new Map<string, Cell>()
    const colCount = new Map<string, number>()
    for (const t of closed) {
      const col = column(t, dim)
      const row = cells.get(t.strategy) ?? new Map<string, Cell>()
      row.set(col, add(row.get(col), t.pnl!))
      cells.set(t.strategy, row)
      totals.set(t.strategy, add(totals.get(t.strategy), t.pnl!))
      colCount.set(col, (colCount.get(col) ?? 0) + 1)
    }
    const cols = dim === 'dte' ? DTE_COLS : dim === 'iv' ? IV_COLS
      : [...colCount.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
    const rows = [...totals.entries()].sort((a, b) => b[1].pnl - a[1].pnl).map(([r]) => r)
    let max = 1
    cells.forEach((row) => row.forEach((c) => { max = Math.max(max, Math.abs(c.pnl)) }))
    return { cells, totals, cols, rows, max }
  }, [closed, dim])

  if (!closed.length) return null

  return (
    <section className="panel p-5 md:p-6" aria-labelledby="heat-h">
      <Heading right={<Segmented<Dim> label="Columns" value={dim} options={DIMS} onChange={setDim} />}>
        <span id="heat-h">Realized P&L by strategy</span>
      </Heading>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-1 text-[13px]">
          <thead>
            <tr className="text-xs text-ink-3">
              <th scope="col"><span className="sr-only">Strategy</span></th>
              {grid.cols.map((c) => <th key={c} scope="col" className="px-2 pb-1 text-center font-normal">{c}</th>)}
              <th scope="col" className="px-2 pb-1 text-center font-normal">Total</th>
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((r) => {
              const tot = grid.totals.get(r)!
              return (
                <tr key={r}>
                  <th scope="row" className="whitespace-nowrap pr-3 text-left font-normal text-ink-2">{r}</th>
                  {grid.cols.map((c) => {
                    const cell = grid.cells.get(r)?.get(c)
                    if (!cell) return <td key={c} className="h-12 rounded-[var(--radius-sm)] bg-surface-2/60 text-center text-xs text-ink-3">-</td>
                    const a = 0.1 + Math.min(1, Math.abs(cell.pnl) / grid.max) * 0.5
                    const bg = cell.pnl >= 0 ? `rgb(79 191 130 / ${a})` : `rgb(229 100 92 / ${a})`
                    return (
                      <td key={c} className="h-12 rounded-[var(--radius-sm)] px-2 text-center" style={{ background: bg }}
                        title={`${r}, ${c}: ${countLabel(cell.n)}`}>
                        <div className="num text-ink">{signedMoney(cell.pnl)}</div>
                        <div className="num text-[11px] text-ink-2">{countLabel(cell.n)}, {Math.round((cell.wins / cell.n) * 100)}% won</div>
                      </td>
                    )
                  })}
                  <td className="h-12 rounded-[var(--radius-sm)] border border-line px-2 text-center">
                    <div className={`num ${tone(tot.pnl)}`}>{signedMoney(tot.pnl)}</div>
                    <div className="num text-[11px] text-ink-3">{countLabel(tot.n)}, {Math.round((tot.wins / tot.n) * 100)}% won</div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
