import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { signedMoney } from '../lib/format'
import { pnlAt, type Position } from '../lib/payoff'

const DAY_MS = 86_400_000
const PRICE_STEPS = [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10]
const VOL_STEPS = [20, 15, 10, 5, 0, -5, -10, -15, -20]

/**
 * Risk navigator: position P&L (against what was paid) for each change in the underlying (columns) and in implied
 * vol (rows), on a chosen day up to expiry. Black-Scholes, every leg's vol shifted by the same number of points.
 */
export function RiskHeatmap({ position, spot, underlying }: { position: Position; spot: number; underlying: string }) {
  const [nlv, setNlv] = useState<number | null>(null)
  useEffect(() => {
    api.account().then((a) => setNlv(a.at(-1)?.net_liquidation ?? null)).catch(() => setNlv(null))
  }, [])

  const expiry = Math.min(...position.legs.filter((l) => l.right !== 'S').map((l) => new Date(`${l.expiry}T20:00:00Z`).getTime()))
  const today = new Date()
  today.setUTCHours(20, 0, 0, 0)  // value at each day's close
  const maxDay = Math.max(0, Math.round((expiry - today.getTime()) / DAY_MS))
  const [day, setDay] = useState(0)
  const [hover, setHover] = useState<string | null>(null)
  const at = today.getTime() + day * DAY_MS

  const grid = useMemo(() => VOL_STEPS.map((dv) => PRICE_STEPS.map((p) => {
    const legs = position.legs.map((l) => ({ ...l, iv: Math.max(0.05, l.iv + dv / 100) }))
    return pnlAt({ ...position, legs }, spot * (1 + p / 100), at)
  })), [position, spot, at])
  const scale = Math.max(1, ...grid.flat().map(Math.abs))
  const date = new Date(at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="risk-day" className="text-xs text-ink-3">Day</label>
        <input id="risk-day" type="range" min={0} max={maxDay} step={1} value={day} onChange={(e) => setDay(+e.target.value)}
          className="min-w-[160px] flex-1 accent-[var(--color-ink)]" />
        <span className="num w-44 text-right text-xs text-ink-2">{date} · {maxDay - day} DTE</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-[2px] text-[12px]">
          <thead>
            <tr>
              <th scope="col" className="w-14 text-left text-[11px] font-normal text-ink-3">Vol / {underlying}</th>
              {PRICE_STEPS.map((p) => (
                <th key={p} scope="col" className="pb-1 font-normal text-ink-3">
                  <div className="num">{p > 0 ? '+' : ''}{p}%</div>
                  <div className="num text-[10.5px]">{(spot * (1 + p / 100)).toFixed(2)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {VOL_STEPS.map((dv, i) => (
              <tr key={dv}>
                <th scope="row" className="num text-left font-normal text-ink-3">{dv > 0 ? '+' : ''}{dv}</th>
                {grid[i].map((v, j) => {
                  const t = Math.pow(Math.min(1, Math.abs(v) / scale), 0.7)
                  const strong = t > 0.55
                  const tip = `${underlying} ${PRICE_STEPS[j] > 0 ? '+' : ''}${PRICE_STEPS[j]}%, vol ${dv > 0 ? '+' : ''}${dv} pts, ${date}: `
                    + `${signedMoney(v)}${nlv ? ` (${((v / nlv) * 100).toFixed(1)}% of account)` : ''}`
                  return (
                    <td key={j} title={tip} onMouseEnter={() => setHover(tip)}
                      className={`num rounded-[3px] py-1.5 text-center ${strong ? 'text-bg' : 'text-ink'} ${dv === 0 && PRICE_STEPS[j] === 0 ? 'outline outline-1 outline-ink-3' : ''}`}
                      style={{ background: `color-mix(in srgb, var(--color-${v >= 0 ? 'pos' : 'neg'}) ${Math.round(t * 85)}%, var(--color-surface-2))` }}>
                      {signedMoney(v)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 min-h-4 text-xs text-ink-2">{hover ?? 'Hover a cell for its share of the account.'}</p>
      <p className="mt-1 text-xs text-ink-3">
        P&L against what you paid, after commissions. Columns: {underlying} from {spot.toFixed(2)} in 2% steps. Rows: implied vol
        shifted by the same number of points on every leg. Black-Scholes, valued at each day's close.
      </p>
    </div>
  )
}
