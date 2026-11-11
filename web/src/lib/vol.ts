/** api for the volatility tab: one ticker's vol and options flow, read from tws by server/vol.py. */

export type FlowRow = {
  expiry: string // YYYYMMDD
  dte: number
  strike: number
  right: 'C' | 'P'
  bid: number | null
  ask: number | null
  last: number | null
  price: number | null // mid, or last without a quote
  volume: number
  oi: number | null
  oi_date: string | null // when tws last sent this contract's open interest (it changes once a day)
  prev_volume: number | null // the contract's volume in the last session before today
  iv: number | null
  delta: number | null
  premium: number // volume × price × 100
  side: 'ask' | 'bid' | 'mid' | null // where the last trade printed against the quote
  new: number | null // contracts traded since the previous load; null on the first load
}

export type TermPoint = { expiry: string; dte: number; iv: number }

export type Vol = {
  symbol: string
  as_of: string
  source: 'live' | 'delayed' | 'simulated'
  seconds: number
  spot: number
  prev_close: number | null
  iv30: number | null
  rv30: number | null
  iv_rank: number | null
  iv_percentile: number | null
  history: { iv: [string, number][]; rv: [string, number][] }
  term: TermPoint[]
  term_past: { label: string; date: string; term: TermPoint[] }[]
  atm: Record<'30' | '60' | '90', number | null>
  skew: { buckets: string[]; tenors: { label: string; expiry: string; dte: number; values: (number | null)[] }[] }
  skew25: number | null
  forward_factor: { value: number | null; iv30: number | null; iv60: number | null; forward: number | null }
  flow: {
    rows: FlowRow[]
    expiries: string[]
    since: string | null
    call_volume: number
    put_volume: number
    call_premium: number
    put_premium: number
    prev_day: string | null
    near_expiries: string[]
    coverage: { read: number; chain: number; expiries: number; expiries_known: number; traded: number }
    underlying_call_volume: number | null // tws's own count for the whole chain today
    underlying_put_volume: number | null
  }
  sessions: {
    bars: SessionBar[]
    days: { day: string; close: number | null; call_volume: number; put_volume: number; call_premium: number; put_premium: number }[]
    contracts: number
    building: boolean
    done: number
    total: number
    error: string | null
  }
  live: { every: number; error: string | null; next_in: number }
  version: string
  flow_points: { time: string; call_volume: number; put_volume: number; call_premium: number; put_premium: number }[]
  stored: {
    days: number
    since: string | null
    skew25: [string, number][]
    forward_factor: [string, number][]
    atm30: [string, number][]
  }
}

export type SessionBar = {
  time: string // bar start, iso utc
  day: string
  price: number
  call_volume: number
  put_volume: number
  call_premium: number
  put_premium: number
}

export type Watch = { symbol: string; last_viewed: string; days: number }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try { detail = (await res.json()).detail ?? detail } catch { /* not json */ }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

export const volApi = {
  /** live keeps the ticker on the server's minute-by-minute read; refresh reads tws now. */
  get: (symbol: string, { refresh = false, live = true } = {}) =>
    fetch(`/api/vol/${encodeURIComponent(symbol)}?live=${live}${refresh ? '&refresh=true' : ''}`).then((r) => json<Vol>(r)),
  watchlist: () => fetch('/api/vol').then((r) => json<{ watchlist: Watch[]; source: string }>(r)),
  remove: (symbol: string) =>
    fetch(`/api/vol/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' }).then((r) => json<{ watchlist: Watch[] }>(r)),
}

/** 20261120 -> 20 Nov */
export function expiryLabel(e: string, year = false): string {
  const d = new Date(`${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}T12:00:00Z`)
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', ...(year ? { year: '2-digit' } : {}) }).format(d)
}
