/** API for the Sector performance tab: sector SPDR ETFs and benchmarks, collected by server/signals/sectors.py. */

export type SectorFund = { symbol: string; name: string }

export type Sectors = {
  sectors: SectorFund[]
  benchmarks: SectorFund[]
  /** Non-sector funds shown on the rotation graph only (GLD). */
  extras?: SectorFund[]
  /** Dividend-adjusted daily closes by symbol, oldest first; the last can be today's live price. */
  series: Record<string, [string, number][]>
  /** Latest date in any series (YYYY-MM-DD). */
  as_of: string | null
  last_run: { started_at: string; finished_at: string; ok: 0 | 1; message: string } | null
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const sectorsApi = {
  get: () => fetch('/api/signals/sectors').then((r) => json<Sectors>(r)),
  /** Fetches fresh prices first (about 25 s), then returns the page data. */
  collect: () => fetch('/api/signals/sectors/collect', { method: 'POST' }).then((r) => json<Sectors>(r)),
}
