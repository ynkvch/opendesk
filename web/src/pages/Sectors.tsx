import { Info } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RegimeChart, lineColor } from '../charts/RegimeChart'
import { QUADRANT_COLOR, QUADRANT_LABEL, RotationChart, type Role } from '../charts/RotationChart'
import { ExpandButton, ExpandOverlay, cardClass, useExpand } from '../components/Expand'
import { RegimeHeader } from '../components/RegimeHeader'
import { Setting, Settings } from '../components/Settings'
import { ErrorNote, Segmented, Skeleton } from '../components/ui'
import { date, dateYear } from '../lib/format'
import { regimeApi, type Regime, type RegimeKey } from '../lib/regime'
import { rrg } from '../lib/rrg'
import { sectorsApi, type SectorFund, type Sectors } from '../lib/sectors'

type Bench = 'SPY' | 'QQQ'
type Range = '1M' | '3M' | '6M' | 'YTD'
const BENCHES: Bench[] = ['SPY', 'QQQ']
const RANGES: Range[] = ['1M', '3M', '6M', 'YTD']
const MONTHS_BACK: Record<Exclude<Range, 'YTD'>, number> = { '1M': 1, '3M': 3, '6M': 6 }
const MINUS = '−'

/** Choices are remembered per browser; storage can be unavailable (private window). */
function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return allowed.includes(v as T) ? (v as T) : fallback
  } catch {
    return fallback
  }
}
function remember(key: string, v: string) {
  try { localStorage.setItem(key, v) } catch { /* not kept, nothing else lost */ }
}
function useRemembered<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [v, setV] = useState<T>(() => remembered(key, allowed, fallback))
  return [v, (next: T) => { setV(next); remember(key, next) }] as const
}

const signed = (v: number, digits: number) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(digits)}`
const pctFmt1 = (v: number) => `${signed(v, 1)}%`
const ptsFmt = (v: number) => `${signed(v, 1)} pts`
const day = (d: string) => d + 'T12:00:00Z'

/** Last close of the day before the range starts: N months back, or the last close of last year for YTD. */
function baseDate(last: string, range: Range): string {
  if (range === 'YTD') return `${Number(last.slice(0, 4)) - 1}-12-31`
  const d = new Date(last + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() - MONTHS_BACK[range])
  return d.toISOString().slice(0, 10)
}

/** Cumulative return in % from the last close on or before `base`, so the line starts at 0. */
function rebase(points: [string, number][], base: string): [string, number][] {
  let i = 0
  for (let k = 0; k < points.length && points[k][0] <= base; k++) i = k
  const v0 = points[i]?.[1]
  return v0 ? points.slice(i).map(([d, v]) => [d, (v / v0 - 1) * 100]) : []
}

/** A sector and its benchmark over one range: both lines, both returns, and the gap between them. */
function compare(data: Sectors, symbol: string, bench: Bench, range: Range) {
  if (!data.as_of) return null
  const base = baseDate(data.as_of, range)
  const benchLine = rebase(data.series[bench] ?? [], base)
  const line = rebase(data.series[symbol] ?? [], base)
  const benchRet = benchLine.at(-1)?.[1]
  const ret = line.at(-1)?.[1]
  if (benchRet == null || ret == null) return null
  return { benchLine, line, benchRet, ret, excess: ret - benchRet, from: benchLine[0][0], to: benchLine.at(-1)![0] }
}

export function SectorsView({ path }: { path: string }) {
  const [data, setData] = useState<Sectors | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collecting, setCollecting] = useState(false)

  const load = useCallback(() => {
    sectorsApi.get().then((r) => { setData(r); setError(null) }).catch((e: Error) => setError(e.message))
  }, [])
  useEffect(load, [load])
  // regime votes pick which sectors get rings; the page still works without them
  const [regime, setRegime] = useState<Regime | null>(null)
  useEffect(() => { regimeApi.get().then(setRegime).catch(() => setRegime(null)) }, [])
  // the server refetches prices when they are 15 minutes old; pick that up without a reload
  useEffect(() => {
    const id = window.setInterval(() => { if (!document.hidden) load() }, 60_000)
    return () => window.clearInterval(id)
  }, [load])
  const collect = useCallback(() => {
    setCollecting(true)
    sectorsApi.collect()
      .then((r) => { setData(r); setError(null) })
      .catch((e: Error) => setError(e.message))
      .finally(() => setCollecting(false))
  }, [])

  const header = (
    <RegimeHeader path={path} run={data?.last_run} collecting={collecting} onReload={data ? collect : undefined}
      reloadTitle="Fetch fresh prices from Yahoo Finance now (about 25 s)" />
  )
  if (error && !data) return <>{header}<ErrorNote message={error} onRetry={load} /></>
  if (!data) return <>{header}<PageSkeleton /></>
  if (!data.as_of) {
    return <>{header}<ErrorNote message={data.last_run?.message || 'No prices collected yet'} onRetry={collect} /></>
  }

  return (
    <>
      {header}
      {error && <ErrorNote message={error} />}
      <Rotation data={data} regime={regime} />
      <section aria-label="Sector charts" className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {[...data.sectors, ...(data.extras ?? [])].map((s) => <SectorChart key={s.symbol} fund={s} data={data} />)}
      </section>
    </>
  )
}

type Mode = 'raw' | 'beta'
type Trail = '1W' | '1M' | '3M'
type RoutedRegime = Exclude<RegimeKey, 'uncertain'>
const MODES: Mode[] = ['raw', 'beta']
const TRAILS: Trail[] = ['1W', '1M', '3M']
// 1W is too short for weekly points, so it steps one session at a time
const TRAIL_POINTS: Record<Trail, { points: number; step: number }> = {
  '1W': { points: 5, step: 1 }, '1M': { points: 4, step: 5 }, '3M': { points: 13, step: 5 },
}

/**
 * which etfs each regime favours or avoids, following the sector cycle: growth up maps to expansion, growth down
 * to contraction, inflation to late cycle. expansion favours XLB over XLY; growth down also gets gold (GLD) as a
 * long and avoids XLI. liquidity keeps the macro cards' "growth over value" tilt, and risk-off keeps gold (GLD).
 */
const ROLES: Record<RoutedRegime, { short: string; favoured: string[]; avoid: string[] }> = {
  growth_up: { short: 'Growth ↑', favoured: ['XLI', 'XLK', 'XLB'], avoid: ['XLU', 'XLP'] },
  growth_down: { short: 'Growth ↓', favoured: ['XLU', 'XLV', 'XLP', 'GLD'], avoid: ['XLF', 'XLY', 'XLK', 'XLI'] },
  inflation: { short: 'Inflation', favoured: ['XLE', 'XLB', 'XLP'], avoid: ['XLK', 'XLY'] },
  risk_off: { short: 'Risk-off', favoured: ['GLD'], avoid: ['XLK', 'XLY', 'XLF'] },
  liquidity: { short: 'Liquidity', favoured: ['XLK', 'XLC', 'XLY'], avoid: [] },
}
const ROUTED = Object.keys(ROLES) as RoutedRegime[]

/** The regime with the most signals pointing to it; ties go to the earlier one in routing order. */
function topRegime(regime: Regime | null): RoutedRegime {
  if (!regime) return 'growth_up'
  return ROUTED.reduce((best, k) => ((regime.votes[k]?.length ?? 0) > (regime.votes[best]?.length ?? 0) ? k : best), ROUTED[0])
}

/**
 * Every sector on one relative rotation graph against SPY or QQQ, raw or beta-adjusted, with rings on the sectors
 * the chosen regime favours (solid) or avoids (dashed), and the numbers behind it in a table.
 */
function Rotation({ data, regime }: { data: Sectors; regime: Regime | null }) {
  const [bench, setBench] = useRemembered<Bench>('sectors.rrg.bench', BENCHES, 'SPY')
  const [mode, setMode] = useRemembered<Mode>('sectors.rrg.mode', MODES, 'beta')
  const [trail, setTrail] = useRemembered<Trail>('sectors.rrg.trail', TRAILS, '1M')
  const [picked, setPicked] = useState<RoutedRegime | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const regimeKey = picked ?? topRegime(regime)

  const rows = useMemo(() => [...data.sectors, ...(data.extras ?? [])]
    .flatMap((s) => {
      const r = rrg(data.series[s.symbol] ?? [], data.series[bench] ?? [], s.symbol, TRAIL_POINTS[trail].points, mode === 'beta',
        TRAIL_POINTS[trail].step)
      return r ? [{ ...r, name: s.name }] : []
    })
    .sort((a, b) => b.trail[b.trail.length - 1].ratio - a.trail[a.trail.length - 1].ratio), [data, bench, trail, mode])
  const roles = useMemo(() => {
    const out: Record<string, Role> = {}
    for (const s of ROLES[regimeKey].favoured) out[s] = 'favoured'
    for (const s of ROLES[regimeKey].avoid) out[s] = 'avoid'
    return out
  }, [regimeKey])
  if (!rows.length) return null
  const asOf = rows[0].trail[rows[0].trail.length - 1].date
  const regimeName = regime?.regimes[regimeKey] ?? ROLES[regimeKey].short
  const gap = (v: number) => <span className={v < 0 ? 'text-neg' : 'text-ink'}>{signed(v, 1)}</span>

  return (
    <section aria-labelledby="rotation-h" className="panel p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 id="rotation-h" className="text-[16px] font-medium tracking-tight text-ink">Sector rotation against {bench}</h2>
            <div className="group relative inline-flex">
              <button type="button" aria-label="How the rotation chart is read" className="inline-flex text-ink-3 hover:text-ink-2">
                <Info size={15} />
              </button>
              <div role="tooltip"
                className="invisible absolute left-0 top-6 z-20 w-[480px] max-w-[80vw] rounded-[var(--radius-md)] border border-line-strong bg-surface-2 p-3 text-[12px] leading-relaxed text-ink-2 opacity-0 shadow-xl transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                <p>Each dot is a sector today (GLD is gold, for comparison). Hover one to see its path, one point per week (per session on 1W). Sectors usually move clockwise:
                  improving → leading → weakening → lagging.</p>
                <ul className="mt-2 list-disc space-y-0.5 pl-4">
                  <li>RS-Ratio: the sector against {bench}, divided by its own 50-day average. Right of 100 = outperforming.</li>
                  <li>RS-Momentum: RS-Ratio against itself 10 days earlier. Above 100 = the lead is growing (or the lag shrinking).</li>
                  <li>β-adjusted: removes the part of each move that β × {bench} explains, so a high-beta sector does not
                    lead just because the market rose. β comes from the last 252 daily returns.</li>
                  <li>Solid ring: a sector the chosen regime favours. Dashed ring: one it avoids. The regime-to-ETF mapping
                    follows the sector cycle: expansion, contraction and late cycle.</li>
                </ul>
                <p className="mt-2 border-t border-line pt-2 text-ink-3">
                  An open approximation of de Kempenaer's RRG (the original formula is not public). A layout of momentum, not
                  new information; the clockwise loop is partly mechanical.
                </p>
              </div>
            </div>
          </div>
          <div className="mt-1 text-[12px] text-ink-3">
            {mode === 'beta' ? 'Beta-adjusted' : 'Raw'} · {trail} paths on hover · to {date(day(asOf))} · rings: {regimeName}
            {regime ? ` (${regime.votes[regimeKey]?.length ?? 0} of ${regime.signals.length} signals)` : ' (regime data unavailable)'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Segmented<Trail> label="Trail" value={trail} onChange={setTrail} options={TRAILS.map((t) => ({ value: t, label: t }))} />
          <Settings>
            <Setting label="Regime">
              <Segmented<RoutedRegime> label="Regime" value={regimeKey} onChange={setPicked}
                options={ROUTED.map((k) => ({ value: k, label: `${ROLES[k].short}${regime ? ` ${regime.votes[k]?.length ?? 0}` : ''}` }))} />
            </Setting>
            <Setting label="Relative strength">
              <Segmented<Mode> label="Relative strength" value={mode} onChange={setMode}
                options={[{ value: 'raw', label: 'Raw' }, { value: 'beta', label: 'β-adj' }]} />
            </Setting>
            <Setting label="Benchmark">
              <Segmented<Bench> label="Benchmark" value={bench} onChange={setBench} options={BENCHES.map((b) => ({ value: b, label: b }))} />
            </Setting>
          </Settings>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-ink-3">
        {(Object.keys(QUADRANT_COLOR) as (keyof typeof QUADRANT_COLOR)[]).map((q) => (
          <span key={q} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: QUADRANT_COLOR[q] }} />{QUADRANT_LABEL[q]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full border-[1.5px] border-ink" />Favoured by {ROLES[regimeKey].short}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full border-[1.5px] border-dashed border-ink" />Avoided
        </span>
      </div>

      <div className="mt-2">
        <RotationChart rows={rows} roles={roles} bench={bench} hovered={hovered} onHover={setHovered}
          ariaLabel={`Relative rotation graph of ${rows.length} sector ETFs against ${bench}, ${mode === 'beta' ? 'beta-adjusted' : 'raw'}`} />
      </div>

      <table className="mt-4 w-full border-collapse text-[13px]">
        <thead className="text-left text-[11px] text-ink-3">
          <tr className="border-b border-line">
            <th className="py-1.5 pr-3 font-normal">Sector</th>
            <th className="py-1.5 pr-3 font-normal">Quadrant</th>
            <th className="hidden py-1.5 pr-3 font-normal md:table-cell">{ROLES[regimeKey].short}</th>
            <th className="py-1.5 pr-3 text-right font-normal">β</th>
            <th className="py-1.5 pr-3 text-right font-normal">20d vs {bench}</th>
            <th className="py-1.5 pr-3 text-right font-normal">20d β-adj</th>
            <th className="py-1.5 pr-3 text-right font-normal">60d vs {bench}</th>
            <th className="py-1.5 text-right font-normal">60d β-adj</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} onMouseEnter={() => setHovered(r.symbol)} onMouseLeave={() => setHovered(null)}
              className={`border-b border-line last:border-b-0 ${hovered === r.symbol ? 'bg-surface-2' : ''}`}>
              <td className="py-1.5 pr-3">
                <span className="num inline-block w-11 font-medium text-ink">{r.symbol}</span>
                <span className="text-ink-2">{r.name}</span>
              </td>
              <td className="py-1.5 pr-3">
                <span className="inline-flex items-center gap-1.5 text-ink-2">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: QUADRANT_COLOR[r.quadrant] }} />
                  {QUADRANT_LABEL[r.quadrant]}
                </span>
              </td>
              <td className="hidden py-1.5 pr-3 text-ink-2 md:table-cell">
                {roles[r.symbol] === 'favoured' ? 'Favoured' : roles[r.symbol] === 'avoid' ? 'Avoid' : <span className="text-ink-3">–</span>}
              </td>
              <td className="num py-1.5 pr-3 text-right text-ink-2">{r.beta < 0 ? MINUS : ''}{Math.abs(r.beta).toFixed(2)}</td>
              <td className="num py-1.5 pr-3 text-right">{gap(r.raw20)}</td>
              <td className="num py-1.5 pr-3 text-right font-medium">{gap(r.adj20)}</td>
              <td className="num py-1.5 pr-3 text-right">{gap(r.raw60)}</td>
              <td className="num py-1.5 text-right font-medium">{gap(r.adj60)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-ink-3">
        Gaps in percentage points: sector return minus {bench}'s (raw) or minus β × {bench}'s (β-adj), over 20 and 60
        sessions. Quadrant follows the Raw / β-adj choice above.
      </p>
    </section>
  )
}

/** One sector against SPY or QQQ, laid out like the signal cards, with its own benchmark and range. */
function SectorChart({ fund, data }: { fund: SectorFund; data: Sectors }) {
  const [bench, setBench] = useRemembered<Bench>(`sectors.${fund.symbol}.bench`, BENCHES, 'SPY')
  const [range, setRange] = useRemembered<Range>(`sectors.${fund.symbol}.range`, RANGES, '6M')
  const { ref, full, slot, toggle, close } = useExpand()
  const c = useMemo(() => compare(data, fund.symbol, bench, range), [data, fund.symbol, bench, range])
  // benchmark first (pale), sector second (blue); the gap shades blue where the sector leads and red where it lags
  const lines = useMemo(() => c ? [
    { label: bench, axis: 'left' as const, points: c.benchLine },
    { label: fund.symbol, axis: 'left' as const, points: c.line },
  ] : [], [c, bench, fund.symbol])
  // widest lead and lag over the range, matched by date
  const extremes = useMemo(() => {
    if (!c) return null
    const b = new Map(c.benchLine)
    let lead: [string, number] | null = null
    let lag: [string, number] | null = null
    for (const [d, v] of c.line) {
      if (!b.has(d)) continue
      const g = v - b.get(d)!
      if (!lead || g > lead[1]) lead = [d, g]
      if (!lag || g < lag[1]) lag = [d, g]
    }
    return { lead, lag }
  }, [c])
  if (!c) return null
  const title = `${fund.symbol} ${fund.name}`

  const card = (
    <article ref={ref} role={full ? 'dialog' : undefined} aria-modal={full || undefined} aria-label={full ? title : undefined}
      className={cardClass(full)}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="flex items-baseline gap-2 text-[16px] font-medium tracking-tight text-ink">
              <span className="num">{fund.symbol}</span><span className="text-ink-2">{fund.name}</span>
            </h2>
            <div className="group relative inline-flex">
              <button type="button" aria-label={`How the ${fund.symbol} chart is read`} className="inline-flex text-ink-3 hover:text-ink-2">
                <Info size={15} />
              </button>
              <div role="tooltip"
                className="invisible absolute left-0 top-6 z-20 w-[380px] max-w-[80vw] rounded-[var(--radius-md)] border border-line-strong bg-surface-2 p-3 text-[12px] leading-relaxed text-ink-2 opacity-0 shadow-xl transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                <p>Both lines start at 0% on the close before the range and show the total return since, dividends reinvested.</p>
                <ul className="mt-2 list-disc space-y-0.5 pl-4">
                  <li>Pale line: {bench}. Blue line: {fund.symbol}.</li>
                  <li>Blue shading: {fund.symbol} ahead of {bench}. Red: behind.</li>
                  <li>The gap is in percentage points: {fund.symbol}'s return minus {bench}'s.</li>
                </ul>
                <p className="mt-2 border-t border-line pt-2 text-ink-3">Yahoo Finance daily closes · 15 min delayed during the session</p>
              </div>
            </div>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={`inline-flex items-center gap-1.5 text-[13px] font-medium ${c.excess < 0 ? 'text-neg' : 'text-pos'}`}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${c.excess < 0 ? 'bg-neg' : 'bg-pos'}`} />
              {c.excess < 0 ? 'Lagging' : 'Leading'} {bench} by <span className="num">{Math.abs(c.excess).toFixed(1)} pts</span>
            </span>
            <span className="text-[11px] text-ink-3">data to {date(day(c.to))}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Segmented<Bench> label="Benchmark" value={bench} onChange={setBench} options={BENCHES.map((b) => ({ value: b, label: b }))} />
          <Segmented<Range> label="Range" value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r, label: r }))} />
          <ExpandButton full={full} onClick={toggle} />
        </div>
      </header>

      <div className={`mt-4 ${full ? 'h-[500px]' : 'min-h-0 flex-1'}`}>
        <RegimeChart lines={lines} levels={[]} format={pctFmt1} fillGap gapLabel={`vs ${bench}`} formatGap={ptsFmt}
          ariaLabel={`${title} against ${bench}, ${range}`} />
      </div>

      <footer className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-3">
        {lines.map((l, i) => {
          const v = l.points.at(-1)?.[1] ?? 0
          return (
            <span key={l.label} className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded" style={{ background: lineColor(i, 2) }} />
              {l.label}: <span className={`num ${v < 0 ? 'text-neg' : 'text-ink'}`}>{pctFmt1(v)}</span>
            </span>
          )
        })}
        <span>Gap: <span className={`num ${c.excess < 0 ? 'text-neg' : 'text-ink'}`}>{ptsFmt(c.excess)}</span></span>
        {full && extremes?.lead && extremes.lag && (
          <>
            <span>Widest lead: <span className="num text-ink-2">{ptsFmt(extremes.lead[1])}</span> on {date(day(extremes.lead[0]))}</span>
            <span>Widest lag: <span className="num text-ink-2">{ptsFmt(extremes.lag[1])}</span> on {date(day(extremes.lag[0]))}</span>
          </>
        )}
      </footer>
      {full && (
        <p className="mt-1 text-[11px] text-ink-3">
          From the close of {dateYear(day(c.from))} to {dateYear(day(c.to))}, total return with dividends reinvested.
        </p>
      )}
    </article>
  )
  return <ExpandOverlay full={full} slot={slot} onClose={close}>{card}</ExpandOverlay>
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-[420px]" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Skeleton className="h-[450px]" />
        <Skeleton className="h-[450px]" />
      </div>
    </div>
  )
}
