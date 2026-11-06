/**
 * Relative rotation graph (RRG) maths for the Sector performance page.
 *
 * The original JdK RS-Ratio and RS-Momentum formulas are proprietary; this is an open approximation:
 *   relative line  = sector ÷ benchmark (raw), or a beta-adjusted index (below)
 *   RS-Ratio       = 100 × relative line ÷ its 50-day average        (> 100: outperforming)
 *   RS-Momentum    = 100 × RS-Ratio ÷ RS-Ratio 10 days earlier       (> 100: the lead is growing)
 * Beta-adjusted line: compounds the sector's daily return minus β × the benchmark's, so a sector that only moves
 * with its sensitivity to the market stays flat. β is one number from the last 252 daily returns.
 */

export type Quadrant = 'leading' | 'weakening' | 'lagging' | 'improving'
export type RrgPoint = { date: string; ratio: number; mom: number }
export type RrgRow = {
  symbol: string
  beta: number
  /** Weekly points, oldest first; the last is the latest close. */
  trail: RrgPoint[]
  quadrant: Quadrant
  /** Sector return minus benchmark return over 20 and 60 sessions, in percentage points. */
  raw20: number
  raw60: number
  /** Sector return minus β × benchmark return, in percentage points. */
  adj20: number
  adj60: number
}

const RATIO_MA = 50
const MOM_LAG = 10
const BETA_DAYS = 252
const STEP = 5 // one trail point per week of sessions

export const quadrantOf = (ratio: number, mom: number): Quadrant =>
  ratio >= 100 ? (mom >= 100 ? 'leading' : 'weakening') : mom >= 100 ? 'improving' : 'lagging'

/** Closes of both symbols on the dates they share, oldest first. */
function align(a: [string, number][], b: [string, number][]) {
  const other = new Map(b)
  const dates: string[] = [], x: number[] = [], y: number[] = []
  for (const [d, v] of a) {
    const w = other.get(d)
    if (w != null) { dates.push(d); x.push(v); y.push(w) }
  }
  return { dates, x, y }
}

const returns = (v: number[]) => v.slice(1).map((c, i) => c / v[i] - 1)

function betaOf(rx: number[], ry: number[]): number {
  const n = Math.min(BETA_DAYS, rx.length)
  const xs = rx.slice(-n), ys = ry.slice(-n)
  const mx = xs.reduce((s, v) => s + v, 0) / n
  const my = ys.reduce((s, v) => s + v, 0) / n
  let cov = 0, vary = 0
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vary += (ys[i] - my) ** 2 }
  return vary ? cov / vary : 1
}

/** One sector against a benchmark; null when there is not enough shared history. */
export function rrg(sector: [string, number][], bench: [string, number][], symbol: string, weeks: number,
  adjusted: boolean): RrgRow | null {
  const { dates, x, y } = align(sector, bench)
  const last = dates.length - 1
  if (last < RATIO_MA + MOM_LAG + STEP * weeks) return null
  const rx = returns(x), ry = returns(y)
  const beta = betaOf(rx, ry)

  const rel = adjusted
    ? rx.reduce((line, r, i) => { line.push(line[i] * (1 + r - beta * ry[i])); return line }, [1])
    : x.map((v, i) => v / y[i])
  let sum = 0
  const ratio: (number | null)[] = rel.map((v, i) => {
    sum += v
    if (i >= RATIO_MA) sum -= rel[i - RATIO_MA]
    return i >= RATIO_MA - 1 ? (100 * v) / (sum / RATIO_MA) : null
  })
  const point = (i: number): RrgPoint => ({ date: dates[i], ratio: ratio[i]!, mom: (100 * ratio[i]!) / ratio[i - MOM_LAG]! })
  const trail = Array.from({ length: weeks + 1 }, (_, k) => point(last - STEP * (weeks - k)))

  const ret = (v: number[], n: number) => v[last] / v[last - n] - 1
  const gap = (n: number, b: number) => (ret(x, n) - b * ret(y, n)) * 100
  const end = trail[trail.length - 1]
  return {
    symbol, beta, trail, quadrant: quadrantOf(end.ratio, end.mom),
    raw20: gap(20, 1), raw60: gap(60, 1), adj20: gap(20, beta), adj60: gap(60, beta),
  }
}
