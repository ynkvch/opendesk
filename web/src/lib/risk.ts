/** Risk manager page: one contract's quote from TWS, plus the account size and a commission estimate. */

/** us equity session by new york clock; outside 'regular' option quotes stay at the last close */
export type MarketSession = 'pre' | 'regular' | 'post' | 'closed'

export type RiskExpiry = { expiry: string; dte: number; expires_at: string }

export type RiskOverview = {
  symbol: string
  spot: number
  close: number | null
  data_type: 'live' | 'delayed' | 'simulated'
  session: MarketSession
  multiplier: number
  expiries: RiskExpiry[]
  account: { value: number; source: string; as_of: string } | null
  commission: { per_contract: number; source: string }
}

export type RiskQuote = {
  spot: number
  bid: number | null
  ask: number | null
  mid: number | null
  last: number | null
  iv: number | null
  delta: number | null
  iv_source: string | null
  data_type: string
  session: MarketSession
  as_of: string
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try { detail = (await res.json()).detail ?? detail } catch { /* not json */ }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

const base = (symbol: string) => `/api/risk/${encodeURIComponent(symbol)}`

export const riskApi = {
  overview: (symbol: string) => fetch(base(symbol)).then((r) => json<RiskOverview>(r)),
  strikes: (symbol: string, expiry: string) =>
    fetch(`${base(symbol)}/${expiry}/strikes`).then((r) => json<{ expiry: string; strikes: number[] }>(r)),
  quote: (symbol: string, expiry: string, strike: number, right: 'C' | 'P') =>
    fetch(`${base(symbol)}/${expiry}/quote?strike=${strike}&right=${right}`).then((r) => json<RiskQuote>(r)),
}

const NY = 'America/New_York'
const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: NY, timeZoneName: 'shortOffset' })
const partsFmt = new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })

/** UTC ms of a New York wall-clock time on a New York date (YYYY-MM-DD). */
export function nyAt(day: string, hour: number, minute = 0): number {
  const guess = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), hour, minute)
  const name = offsetFmt.formatToParts(new Date(guess)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5'
  const m = name.match(/GMT([+-]\d+)(?::(\d+))?/)
  const off = m ? (+m[1] * 60 + Math.sign(+m[1]) * +(m[2] ?? 0)) : -300
  return guess - off * 60_000
}

/** New York date (YYYY-MM-DD) and weekday of a moment. */
export function nyDay(ms: number): { day: string; weekday: string } {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday }
}

const STEP_MS = 30 * 60_000

/**
 * The moments the time slider steps through: now, then every 30 minutes of the remaining sessions when expiry is
 * three days or less away, otherwise each weekday's 16:00 close. The last one is always the expiry close.
 */
export function timeSteps(now: number, expiry: number): number[] {
  if (expiry <= now) return [expiry]
  const out = [now]
  const intraday = expiry - now <= 3 * 86_400_000
  for (let d = now; d <= expiry + 86_400_000; d += 86_400_000) {
    const { day, weekday } = nyDay(d)
    if (weekday === 'Sat' || weekday === 'Sun') continue
    const open = nyAt(day, 9, 30), close = nyAt(day, 16)
    if (intraday) {
      for (let t = open + STEP_MS; t <= close; t += STEP_MS) if (t > now && t <= expiry) out.push(t)
    } else if (close > now && close <= expiry) out.push(close)
  }
  if (out[out.length - 1] !== expiry) out.push(expiry)
  return [...new Set(out)].sort((a, b) => a - b)
}
