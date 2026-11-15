// variance risk premium for the flow page: 30-day implied minus 30-day realized volatility, in vol points.

export type Point = [string, number]
export type VrpRange = '6M' | '1Y' | 'All'
export const VRP_RANGES: VrpRange[] = ['6M', '1Y', 'All']
const RANGE_MONTHS: Record<Exclude<VrpRange, 'All'>, number> = { '6M': 6, '1Y': 12 }

/** implied minus realized on each day both have a value, in vol points (0.30 - 0.25 is 5). */
export function vrpSeries(iv: Point[], rv: Point[]): Point[] {
  const realized = new Map(rv)
  return iv.flatMap(([d, v]) => {
    const r = realized.get(d)
    return r == null ? [] : [[d, (v - r) * 100] as Point]
  })
}

/** the points from `range` before `today` (YYYY-MM-DD) on, by calendar month; 'All' keeps everything. */
export function vrpWindow(points: Point[], range: VrpRange, today: string): Point[] {
  if (range === 'All') return points
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - RANGE_MONTHS[range])
  const from = d.toISOString().slice(0, 10)
  return points.filter((p) => p[0] >= from)
}

export type VrpStats = { now: number | null; mean: number | null; sd: number | null; z: number | null }

/** the latest value, the mean, the sample standard deviation and how many of them the latest sits from the mean. */
export function vrpStats(points: Point[]): VrpStats {
  const xs = points.map((p) => p[1])
  const now = xs.length ? xs[xs.length - 1] : null
  const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
  const sd = mean != null && xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : null
  const z = now != null && mean != null && sd ? (now - mean) / sd : null
  return { now, mean, sd, z }
}
