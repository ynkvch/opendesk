import { X } from '@phosphor-icons/react'
import { useEffect, useRef, type Dispatch, type ReactNode, type SetStateAction } from 'react'

export type Status = 'all' | 'open' | 'closed'
export type Outcome = 'all' | 'win' | 'loss'

export type Filters = {
  assets: string[]
  strategies: string[]
  symbols: string[]
  status: Status
  outcome: Outcome
}

export const EMPTY_FILTERS: Filters = { assets: [], strategies: [], symbols: [], status: 'all', outcome: 'all' }

export const ASSET_LABEL: Record<string, string> = { OPT: 'Options', STK: 'Stock' }
export const STATUS_LABEL: Record<Status, string> = { all: 'All', open: 'Open', closed: 'Closed' }
export const OUTCOME_LABEL: Record<Outcome, string> = { all: 'All', win: 'Winning', loss: 'Losing' }

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={`h-8 rounded-[var(--radius-sm)] border px-3 text-[13px] transition-colors active:translate-y-px ${
        on ? 'border-ink-2 bg-surface-3 text-ink' : 'border-line text-ink-3 hover:border-line-strong hover:text-ink-2'}`}>
      {children}
    </button>
  )
}

function Group({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="border-t border-line px-5 py-4">
      <legend className="sr-only">{label}</legend>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-ink">{label}</span>
        {hint && <span className="text-xs text-ink-3">{hint}</span>}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  )
}

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

/** Right-hand panel with every journal filter. Changes apply as you click. */
export function FilterSheet({ open, onClose, filters, onChange, strategies, symbols, matching }: {
  open: boolean
  onClose: () => void
  filters: Filters
  onChange: Dispatch<SetStateAction<Filters>>
  strategies: string[]
  symbols: string[]
  matching: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // functional update, so quick successive clicks never overwrite each other
  const set = (patch: (f: Filters) => Partial<Filters>) => onChange((f) => ({ ...f, ...patch(f) }))

  return (
    <>
      <div aria-hidden onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-200 ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`} />
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Filter trades" aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-[400px] flex-col border-l border-line-strong bg-bg outline-none transition-transform duration-300 ease-[var(--ease-out-quint)] ${
          open ? 'translate-x-0' : 'pointer-events-none translate-x-full'}`}>
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-5">
          <h2 className="text-[15px] font-medium">Filter trades</h2>
          <button type="button" aria-label="Close filters (Esc)" onClick={onClose}
            className="grid size-8 place-items-center rounded-[var(--radius-sm)] border border-line text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <Group label="Asset">
            {['OPT', 'STK'].map((a) => (
              <Chip key={a} on={filters.assets.includes(a)} onClick={() => set((f) => ({ assets: toggle(f.assets, a) }))}>
                {ASSET_LABEL[a]}
              </Chip>
            ))}
          </Group>
          <Group label="Strategy" hint="Any selected">
            {strategies.map((s) => (
              <Chip key={s} on={filters.strategies.includes(s)} onClick={() => set((f) => ({ strategies: toggle(f.strategies, s) }))}>
                {s}
              </Chip>
            ))}
          </Group>
          <Group label="Symbol" hint="Any selected">
            {symbols.length ? symbols.map((s) => (
              <Chip key={s} on={filters.symbols.includes(s)} onClick={() => set((f) => ({ symbols: toggle(f.symbols, s) }))}>
                {s}
              </Chip>
            )) : <span className="text-xs text-ink-3">No trades yet</span>}
          </Group>
          <Group label="Status">
            {(['all', 'open', 'closed'] as const).map((s) => (
              <Chip key={s} on={filters.status === s} onClick={() => set(() => ({ status: s }))}>{STATUS_LABEL[s]}</Chip>
            ))}
          </Group>
          <Group label="Outcome" hint="Open trades count by current P&L">
            {(['all', 'win', 'loss'] as const).map((o) => (
              <Chip key={o} on={filters.outcome === o} onClick={() => set(() => ({ outcome: o }))}>{OUTCOME_LABEL[o]}</Chip>
            ))}
          </Group>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-5 py-4">
          <button type="button" onClick={() => onChange(EMPTY_FILTERS)}
            className="h-8 rounded-[var(--radius-md)] px-3 text-xs font-medium text-ink-3 hover:bg-surface-2 hover:text-ink">
            Clear all
          </button>
          <button type="button" onClick={onClose}
            className="h-8 rounded-[var(--radius-md)] bg-ink px-4 text-xs font-medium text-bg hover:opacity-90 active:translate-y-px">
            Show {matching} {matching === 1 ? 'trade' : 'trades'}
          </button>
        </div>
      </div>
    </>
  )
}
