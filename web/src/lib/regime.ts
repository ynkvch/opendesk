/** API for the Regime page: the six regime signals collected by server/signals/regime.py. */

export type RegimeKey = 'growth_up' | 'growth_down' | 'inflation' | 'risk_off' | 'liquidity' | 'uncertain'
export type RegimeUnit = 'pct' | 'bp' | 'usd_m' | 'index' | 'pts' | 'pct_chg'

export type RegimeSignal = {
  key: string
  title: string
  source: string
  cadence: string
  /** the signal's rule, as written. */
  rule: string
  /** choices made where the rule leaves a number open. */
  rule_used: string
  unit: RegimeUnit
  value: number | null
  /** Date the latest value covers (YYYY-MM-DD). */
  as_of: string | null
  /** When that value was first collected (ISO, UTC). */
  received: string | null
  /** When the reading last changed (ISO, UTC). */
  reading_since: string | null
  reading: string | null
  tone: 'pos' | 'neg' | 'warn' | 'ink'
  points_to: RegimeKey[]
  lines: { label: string; value: number | null; unit: RegimeUnit }[]
  notes: string[]
  series: { label: string; unit: RegimeUnit; axis: 'left' | 'right'; points: [string, number][] }[]
  /** Levels from the rule, drawn as dashed lines. */
  levels: { value: number; label: string }[]
}

/** how the score is made, set from the gear menu on the Macro tab. */
export type RegimeFormula = {
  parts: { key: string; on: boolean; weight: number; members: Record<string, boolean> }[]
  band: number
}

export type Regime = {
  signals: RegimeSignal[]
  votes: Record<RegimeKey, string[]>
  regimes: Record<RegimeKey, string>
  /** mechanical risk score: a weighted average of the signals in the formula, -100..+100; ±band splits risk-on / neutral / risk-off. */
  score: {
    value: number | null
    label: 'Risk-on' | 'Neutral' | 'Risk-off' | null
    /** the signals that count, in the formula's order; a pair's members are averaged into its points. */
    parts: {
      key: string
      title: string
      weight: number
      points: number
      /** points moved on the -100..+100 score: weight × points ÷ total weight × 100. */
      contribution: number
      members: { key: string; label: string; reading: string; points: number }[]
    }[]
    band: number
    formula: RegimeFormula
    /** every signal the formula can use, with its pair members. */
    families: { key: string; title: string; members: { key: string; label: string }[] }[]
  }
  /** The collector's latest finished run; ok is 0 when it failed, null when a key is missing. */
  last_run: { finished_at: string; ok: 0 | 1 | null; message: string } | null
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const regimeApi = {
  get: () => get<Regime>('/api/signals/regime'),
  /** Fetches fresh data from the sources first (5–10 s), then returns the page data. */
  collect: async () => {
    const res = await fetch('/api/signals/regime/collect', { method: 'POST' })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.json() as Promise<Regime>
  },
  saveFormula: async (formula: RegimeFormula) => {
    const res = await fetch('/api/signals/regime/formula', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formula),
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.json() as Promise<Regime>
  },
  resetFormula: async () => {
    const res = await fetch('/api/signals/regime/formula', { method: 'DELETE' })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.json() as Promise<Regime>
  },
}
