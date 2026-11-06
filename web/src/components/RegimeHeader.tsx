import type { MouseEvent } from 'react'
import { ago } from '../lib/format'
import { navigate } from '../lib/router'

const TABS = [
  { href: '/regime', label: 'Macro' },
  { href: '/regime/sectors', label: 'Sector performance' },
]

type Run = { finished_at: string; ok: 0 | 1 | null; message: string } | null

/** Regime title, its two tabs, and when the tab's data was last collected with a Reload button. */
export function RegimeHeader({ path, run, collecting, onReload, reloadTitle }: {
  path: string
  run?: Run
  collecting?: boolean
  onReload?: () => void
  reloadTitle?: string
}) {
  function go(e: MouseEvent<HTMLAnchorElement>, href: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate(href)
  }

  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">Regime</h1>
        <nav aria-label="Regime views" className="flex items-center gap-1 rounded-[var(--radius-md)] border border-line bg-bg p-0.5">
          {TABS.map((t) => {
            const active = path === t.href
            return (
              <a key={t.href} href={t.href} onClick={(e) => go(e, t.href)} aria-current={active ? 'page' : undefined}
                className={`rounded-[var(--radius-sm)] px-2.5 py-1 text-[13px] font-medium transition-colors ${
                  active ? 'bg-surface-3 text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)]' : 'text-ink-3 hover:text-ink-2'}`}>
                {t.label}
              </a>
            )
          })}
        </nav>
      </div>
      <div className="flex items-center gap-3 text-xs text-ink-3">
        {run && (
          <span className="inline-flex items-center gap-1.5" title={run.message}>
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${run.ok === 1 ? 'bg-pos' : 'bg-neg'}`} />
            {run.ok === 1 ? 'Collected' : 'Last run failed'} <span className="num text-ink-2">{ago(run.finished_at)}</span>
          </span>
        )}
        {onReload && (
          <button type="button" onClick={onReload} disabled={collecting} aria-busy={collecting} title={reloadTitle}
            className="h-8 rounded-[var(--radius-md)] border border-line-strong px-3 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink active:translate-y-px disabled:cursor-wait disabled:opacity-60">
            {collecting ? 'Collecting…' : 'Reload'}
          </button>
        )}
      </div>
    </div>
  )
}
