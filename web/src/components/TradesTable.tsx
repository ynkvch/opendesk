import { CaretDown, CaretUp, NotePencil } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import type { TradeRow } from '../lib/api'
import { date, hold, money, num, rMult, signedMoney, tone, vol } from '../lib/format'
import { Excursion } from './Excursion'

type SortKey = 'opened_at' | 'underlying' | 'pnl' | 'commissions' | 'r_multiple' | 'iv_entry' | 'hold_hours'

/** Sortable trade table. Filtering is up to the page that renders it. */
export function TradesTable({ trades, selected, onOpen, emptyText = 'No trades match these filters.' }: {
  trades: TradeRow[]
  selected: number | null
  /** Called with the clicked trade and the current on-screen order, for next/previous navigation. */
  onOpen: (id: number, order: number[]) => void
  emptyText?: string
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'opened_at', dir: -1 })

  const rows = useMemo(() => [...trades].sort((a, b) => {
    const av = a[sort.key]
    const bv = b[sort.key]
    if (av == null) return 1
    if (bv == null) return -1
    return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir
  }), [trades, sort])
  const order = rows.map((t) => t.id)

  function th(key: SortKey | null, label: string, className = '') {
    const active = key && sort.key === key
    return (
      <th scope="col" className={`h-9 px-3 font-normal ${className}`}
        aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
        {key ? (
          <button type="button" className={`inline-flex items-center gap-1 hover:text-ink-2 ${active ? 'text-ink-2' : ''}`}
            onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}>
            {label}
            {active && (sort.dir === 1 ? <CaretUp size={10} weight="bold" /> : <CaretDown size={10} weight="bold" />)}
          </button>
        ) : label}
      </th>
    )
  }

  return (
      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-[13px]">
          <thead className="text-left text-xs text-ink-3">
            <tr className="border-b border-line">
              {th('opened_at', 'Opened', 'pl-4')}
              {th('underlying', 'Symbol')}
              {th(null, 'Strategy')}
              {th(null, 'Contract')}
              {th(null, 'Qty', 'text-right')}
              {th(null, 'Entry', 'text-right')}
              {th(null, 'Exit', 'text-right')}
              {th('pnl', 'P&L', 'text-right')}
              {th('commissions', 'Fees', 'text-right')}
              {th('r_multiple', 'R', 'text-right')}
              {th(null, 'MAE / MFE')}
              {th('iv_entry', 'IV in', 'text-right')}
              {th('hold_hours', 'Held', 'text-right')}
              <th scope="col" className="w-10 pr-4"><span className="sr-only">Notes</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} tabIndex={0} onClick={() => onOpen(t.id, order)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t.id, order) } }}
                aria-selected={selected === t.id}
                className={`h-11 cursor-pointer border-b border-line transition-colors duration-100 last:border-b-0 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none ${
                  selected === t.id ? 'bg-surface-2' : ''}`}>
                <td className="num pl-4 pr-3 text-ink-2" title={t.open_estimated ? 'Bought before this date' : undefined}>
                  {t.open_estimated ? `Before ${date(t.opened_at)}` : date(t.opened_at)}
                </td>
                <td className="px-3 font-semibold tracking-tight">{t.underlying}</td>
                <td className="px-3 text-ink-2">
                  {t.strategy}
                  {t.status === 'open' && (
                    <span className="ml-2 rounded-[3px] border border-line-strong px-1.5 py-px text-[11px] text-ink">Open</span>
                  )}
                </td>
                <td className="code px-3 text-ink-3">{t.contract}</td>
                <td className="num px-3 text-right text-ink-2">{t.quantity}</td>
                <td className="num px-3 text-right text-ink-2">{num(t.entry_price)}</td>
                <td className="num px-3 text-right text-ink-2">{t.exit_price == null ? '-' : num(t.exit_price)}</td>
                <td className={`num px-3 text-right ${tone(t.pnl)}`}>{signedMoney(t.pnl)}</td>
                <td className="num px-3 text-right text-ink-3">{money(t.commissions, 2)}</td>
                <td className={`num px-3 text-right ${tone(t.r_multiple)}`}>{rMult(t.r_multiple)}</td>
                <td className="px-3"><Excursion mae={t.mae} mfe={t.mfe} pnl={t.pnl} risk={t.max_risk} /></td>
                <td className="num px-3 text-right text-ink-2">{t.asset === 'STK' || !t.iv_entry ? '-' : vol(t.iv_entry)}</td>
                <td className="num px-3 text-right text-ink-2">{t.status === 'open' ? '-' : `${t.open_estimated ? '\u2265' : ''}${hold(t.hold_hours)}`}</td>
                <td className="pr-4 text-right">
                  {t.has_thesis && <NotePencil size={14} className="inline text-ink-3" aria-label="Has thesis" />}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={14} className="px-4 py-12 text-center text-sm text-ink-3">
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
  )
}
