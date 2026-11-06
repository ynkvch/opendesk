/** Option payoff maths: Black-Scholes value per leg, summed into a position P&L curve. */

const RATE = 0.042
const YEAR_MS = 365 * 86_400_000

function erf(x: number): number {
  // Abramowitz-Stegun 7.1.26, max error 1.5e-7
  const s = Math.sign(x)
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)
  return s * y
}
const cdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2))

export function bsPrice(right: 'C' | 'P' | 'S', s: number, k: number, t: number, iv: number): number {
  if (right === 'S') return s
  if (t <= 0 || iv <= 0 || s <= 0) return right === 'C' ? Math.max(0, s - k) : Math.max(0, k - s)
  const d1 = (Math.log(s / k) + (RATE + 0.5 * iv * iv) * t) / (iv * Math.sqrt(t))
  const d2 = d1 - iv * Math.sqrt(t)
  return right === 'C'
    ? s * cdf(d1) - k * Math.exp(-RATE * t) * cdf(d2)
    : k * Math.exp(-RATE * t) * cdf(-d2) - s * cdf(-d1)
}

export type PayoffLeg = { side: 'BUY' | 'SELL'; right: 'C' | 'P' | 'S'; strike: number; expiry: string; iv: number }

export type Position = {
  legs: PayoffLeg[]
  /** Net debit paid per share. */
  entry: number
  quantity: number
  /** 100 for options, 1 for shares */
  multiplier: number
  commissions: number
}

const sign = (l: PayoffLeg) => (l.side === 'BUY' ? 1 : -1)
const expiryTime = (l: PayoffLeg) => (l.right === 'S' ? Number.POSITIVE_INFINITY : new Date(`${l.expiry}T20:00:00Z`).getTime())

/** Position P&L in USD at underlying price `s`, valued at time `at` (ms). Past expiry = intrinsic. */
export function pnlAt(p: Position, s: number, at: number): number {
  let v = 0
  for (const l of p.legs) {
    const t = Math.max(0, (expiryTime(l) - at) / YEAR_MS)
    v += sign(l) * bsPrice(l.right, s, l.strike, t, l.iv)
  }
  return (v - p.entry) * p.multiplier * p.quantity - p.commissions
}

export const pnlAtExpiry = (p: Position, s: number) => pnlAt(p, s, Number.POSITIVE_INFINITY)

/** Underlying prices where the expiry P&L crosses zero. */
export function breakevens(p: Position, lo: number, hi: number, steps = 800): number[] {
  const out: number[] = []
  let ps = lo
  let pv = pnlAtExpiry(p, lo)
  for (let i = 1; i <= steps; i++) {
    const s = lo + ((hi - lo) * i) / steps
    const v = pnlAtExpiry(p, s)
    if ((pv < 0 && v >= 0) || (pv > 0 && v <= 0)) out.push(ps + ((0 - pv) / (v - pv)) * (s - ps))
    ps = s
    pv = v
  }
  return out
}

/** Max profit and loss at expiry; null means unbounded. */
export function extremes(p: Position): { maxProfit: number | null; maxLoss: number | null } {
  // shares behave like calls on the upside: unlimited for long, unbounded loss for short
  const netCalls = p.legs.filter((l) => l.right !== 'P').reduce((a, l) => a + sign(l), 0)
  const strikes = p.legs.map((l) => (l.right === 'S' ? p.entry : l.strike))
  // Expiry payoff is piecewise linear, so extremes sit at 0, a strike, or run off to infinity.
  const probes = [0, ...strikes, Math.max(...strikes) * 3].map((s) => pnlAtExpiry(p, s))
  return {
    maxProfit: netCalls > 0 ? null : Math.max(...probes),
    maxLoss: netCalls < 0 ? null : Math.min(...probes),
  }
}
