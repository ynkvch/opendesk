import { Database } from '@phosphor-icons/react'
import type { MouseEvent } from 'react'
import { dateTime } from '../lib/format'
import { navigate } from '../lib/router'

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/journal', label: 'Journal' },
  { href: '/regime', label: 'Regime' },
  { href: '/flow', label: 'Flow' },
]

export function TopBar({ path, asOf, source }: { path: string; asOf: string | null; source: string | null }) {
  function go(e: MouseEvent<HTMLAnchorElement>, href: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate(href)
    window.scrollTo({ top: 0 })
  }

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between gap-6 px-4 md:px-8">
        <div className="flex items-center gap-6">
          <nav aria-label="Main" className="flex items-center gap-1">
            {LINKS.map((l) => {
              const active = path === l.href
              return (
                <a key={l.href} href={l.href} onClick={(e) => go(e, l.href)} aria-current={active ? 'page' : undefined}
                  className={`rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
                    active ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
                  {l.label}
                </a>
              )
            })}
          </nav>
        </div>
        <div className="flex items-center gap-4 text-xs text-ink-3">
          {source === 'demo' && (
            <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-line-strong px-2 py-1 text-ink-2">
              <Database size={13} aria-hidden />
              Demo data
            </span>
          )}
          {asOf && <span className="hidden sm:inline">As of <span className="num text-ink-2">{dateTime(asOf)}</span></span>}
        </div>
      </div>
    </header>
  )
}
