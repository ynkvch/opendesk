const MINUS = '−'

const usd0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** $1,234 or $1,234.56. Negative values use a true minus sign. */
export function money(v: number | null | undefined, decimals: 0 | 2 = 0): string {
  if (v == null) return '-'
  const f = decimals === 0 ? usd0 : usd2
  return `${v < 0 ? MINUS : ''}$${f.format(Math.abs(v))}`
}

/** +$1,234 / −$1,234, for P&L where the sign is the point. */
export function signedMoney(v: number | null | undefined, decimals: 0 | 2 = 0): string {
  if (v == null) return '-'
  const f = decimals === 0 ? usd0 : usd2
  if (Math.abs(v) < (decimals === 0 ? 0.5 : 0.005)) return `$${f.format(0)}`
  return `${v > 0 ? '+' : MINUS}$${f.format(Math.abs(v))}`
}

export function pct(v: number | null | undefined, decimals = 1, signed = false): string {
  if (v == null) return '-'
  const s = (Math.abs(v) * 100).toFixed(decimals)
  if (!signed) return `${v < 0 ? MINUS : ''}${s}%`
  return `${v > 0 ? '+' : v < 0 ? MINUS : ''}${s}%`
}

export function num(v: number | null | undefined, decimals = 2, signed = false): string {
  if (v == null) return '-'
  const s = Math.abs(v).toFixed(decimals)
  if (v < 0) return `${MINUS}${s}`
  return signed && v > 0 ? `+${s}` : s
}

export function rMult(v: number | null | undefined): string {
  if (v == null) return '-'
  return `${num(v, 2, true)}R`
}

/** IV as vol points: 0.1843 -> 18.4 */
export function vol(v: number | null | undefined): string {
  return v == null ? '-' : (v * 100).toFixed(1)
}

export function hold(hours: number | null | undefined): string {
  if (hours == null) return '-'
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`
  const d = hours / 24
  return d < 10 ? `${d.toFixed(1)}d` : `${Math.round(d)}d`
}

const dFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' })
const dyFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
const tFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })

export const date = (iso: string) => dFmt.format(new Date(iso))
export const dateYear = (iso: string) => dyFmt.format(new Date(iso))
export const time = (iso: string) => tFmt.format(new Date(iso))
export const dateTime = (iso: string) => `${dFmt.format(new Date(iso))}, ${tFmt.format(new Date(iso))}`

export function tone(v: number | null | undefined): string {
  if (v == null || Math.abs(v) < 0.005) return 'text-ink-2'
  return v > 0 ? 'text-pos' : 'text-neg'
}

/** '8 min ago', '3 h ago', '2 d ago' for a past ISO time. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '-'
  const min = (Date.now() - new Date(iso).getTime()) / 60000
  if (min < 1) return 'just now'
  if (min < 60) return `${Math.round(min)} min ago`
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`
  return `${Math.round(min / 1440)} d ago`
}
