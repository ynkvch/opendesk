import { useSyncExternalStore } from 'react'

/** Minimal history-API router: two pages plus a `?trade=` overlay. */

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
window.addEventListener('popstate', notify)

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

const snapshot = () => location.pathname + location.search

export function useLocation() {
  const href = useSyncExternalStore(subscribe, snapshot)
  const url = new URL(href, location.origin)
  const trade = url.searchParams.get('trade')
  return { path: url.pathname, trade: trade ? Number(trade) : null }
}

export function navigate(to: string, { replace = false } = {}) {
  if (to === snapshot()) return
  history[replace ? 'replaceState' : 'pushState'](null, '', to)
  notify()
}

/** Same page, with or without the trade overlay open. */
export function withTrade(id: number | null) {
  const url = new URL(location.href)
  if (id == null) url.searchParams.delete('trade')
  else url.searchParams.set('trade', String(id))
  return url.pathname + url.search
}
