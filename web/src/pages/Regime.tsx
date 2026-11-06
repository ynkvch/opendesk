import { Info } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RegimeChart, lineColor } from '../charts/RegimeChart'
import { ExpandButton, ExpandOverlay, cardClass, useExpand } from '../components/Expand'
import { RegimeHeader } from '../components/RegimeHeader'
import { ErrorNote, Segmented, Skeleton } from '../components/ui'
import { ago, date, dateTime } from '../lib/format'
import { regimeApi, type Regime, type RegimeKey, type RegimeSignal, type RegimeUnit } from '../lib/regime'
import { SectorsView } from './Sectors'

/** long, short and options approach per regime. */
const ROUTING: { key: RegimeKey; long: string; short: string; options: string; note?: string }[] = [
  { key: 'growth_up', long: 'Tech, Semis, Consumer Disc, Industrials', short: 'Utilities, Staples, REITs (short or avoid)',
    options: 'Buy calls on leading names; sell puts to enter core longs' },
  { key: 'growth_down', long: 'Staples, Healthcare, Quality factors', short: 'Cyclicals, Small-caps, High-beta',
    options: 'Protective puts, bear spreads on weak sectors' },
  { key: 'inflation', long: 'Energy, Materials, Commodities, Financials', short: 'Long-duration growth, Unprofitable tech',
    options: 'Commodity calls; interest rate structures; short high-multiple growth',
    note: 'None of the six signals measures inflation, so no signal points here.' },
  { key: 'risk_off', long: 'Gold, Short-term treasuries, USD, Vol', short: 'High-beta, EM, Credit-sensitive names',
    options: 'Long vol (straddles, OTM puts); gold calls; VIX calls' },
  { key: 'liquidity', long: 'Risk assets broadly; growth > value', short: 'Nothing aggressively; reduce hedges',
    options: 'Sell premium (high IVP normalizing); buy calls in leading sectors' },
  { key: 'uncertain', long: 'Nothing > 10% of book; wait for signal confirmation', short: 'Small event-driven only',
    options: 'Reduce size to 30-40% of normal; vol surface monitoring only' },
]

const TONE_TEXT = { pos: 'text-pos', neg: 'text-neg', warn: 'text-warn', ink: 'text-ink-2' } as const
const TONE_DOT = { pos: 'bg-pos', neg: 'bg-neg', warn: 'bg-warn', ink: 'bg-ink-3' } as const
const MINUS = '−'
const MONTH_FMT = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' })

function fmt(v: number | null, unit: RegimeUnit, signed = false): string {
  if (v == null) return '-'
  const sign = v < 0 ? MINUS : signed && v > 0 ? '+' : ''
  const a = Math.abs(v)
  switch (unit) {
    case 'pct': return `${sign}${a.toFixed(2)}%`
    case 'bp': return `${sign}${a.toFixed(0)} bp`
    case 'usd_m': return `${sign}$${a >= 999_500 ? `${(a / 1e6).toFixed(2)}T` : `${(a / 1e3).toFixed(0)}bn`}`  // 999,727 is $1.00T, not $1000bn
    case 'pct_chg': return `${sign}${a.toFixed(1)}%`
    case 'pts': return `${sign}${a.toFixed(1)} pts`
    default: return `${sign}${a.toFixed(1)}`
  }
}

type Guide = {
  about: string
  read?: string[]
  /** Table headings; defaults to Level / What it usually means. */
  columns?: [string, string]
  /** A row is marked "now" when the value falls in [from, to), or when `reading` matches the card's reading. */
  bands: { label: string; meaning: string; from?: number; to?: number; reading?: (r: string) => boolean }[]
}

/** Plain-English notes and typical levels for the info box. */
const GUIDES: Record<string, Guide> = {
  liquidity: {
    about: 'TREAST: Treasuries the Fed holds. Buying them adds bank reserves; letting them run off drains reserves.'
      + ' TGA: the government\'s account at the Fed. Taxes and debt sales fill it and drain reserves; spending empties it'
      + ' and adds them back. Reserves are the cash markets run on, so the two together show liquidity.',
    read: [
      'Pale line: TREAST (left axis). Blue line: TGA (right axis).',
      'Each is read over 4 weeks; moves under $5bn count as flat.',
      'Net effect on reserves ≈ TREAST change − TGA change.',
    ],
    columns: ['TREAST + TGA', 'What it means'],
    bands: [
      { label: 'Up + down', meaning: 'Liquidity expansion: growth and high-beta lead', reading: (r) => r === 'Both supportive' },
      { label: 'Down or up', meaning: 'Tightening: defensives and quality lead', reading: (r) => r.startsWith('Tightening') },
      { label: 'Down + up', meaning: 'Both tightening: reduce risk', reading: (r) => r === 'Both tightening' },
      { label: 'Flat', meaning: 'No clear direction', reading: (r) => r === 'No clear direction' },
    ],
  },
  curve: {
    about: 'Gap widening: growth expected. Gap shrinking or below zero: slowdown expected.',
    read: [
      'Pale line: 2Y (where the Fed is heading). Blue line: 10Y (long-run growth).',
      'Widening with the 10Y rising: growth.',
      'Widening with the 2Y falling faster: rate cuts priced in, a warning.',
    ],
    bands: [
      { label: 'Below 0%', from: -Infinity, to: 0, meaning: 'Inverted: market expects rate cuts and a slowdown' },
      { label: '0–0.5%', from: 0, to: 0.5, meaning: 'Flat: late in the cycle, modest growth expectations' },
      { label: '0.5–1.5%', from: 0.5, to: 1.5, meaning: 'Normal (long-run average about 1%)' },
      { label: '1.5–2.5%', from: 1.5, to: 2.5, meaning: 'Steep: early recovery, or rising growth and inflation expectations' },
      { label: 'Above 2.5%', from: 2.5, to: Infinity, meaning: 'Very steep: usually just after a recession (2010 about 2.9%)' },
    ],
  },
  curve_3m: {
    about: 'Like 2s10s, but the 3M bill sits on today\'s Fed rate. Its inversion is the stronger recession signal.',
    read: [
      'Pale line: 3M bill (the Fed rate now). Blue line: 10Y.',
      'Narrowing with the pale line flat: long rates falling toward the Fed rate.',
      'Pale line dropping fast out of red: the Fed cutting, a warning.',
      'Red for over three months: recession warning.',
    ],
    bands: [
      { label: 'Below 0%', from: -Infinity, to: 0, meaning: 'Inverted: policy rate above long rates, recession warning' },
      { label: '0–1%', from: 0, to: 1, meaning: 'Flat: policy still tight against long rates' },
      { label: '1–2%', from: 1, to: 2, meaning: 'Normal (long-run average about 1.5%)' },
      { label: '2–3%', from: 2, to: 3, meaning: 'Steep: policy easy against long rates' },
      { label: 'Above 3%', from: 3, to: Infinity, meaning: 'Very steep: rates near zero after a recession' },
    ],
  },
  credit: {
    about: 'Falling (tightening): lenders accept less extra pay, so risk appetite is growing. Rising (widening): lenders demand more'
      + ' pay because they see more default risk or want more for bearing it, so stress is building.',
    bands: [
      { label: 'Below 3%', from: -Infinity, to: 3, meaning: 'Very tight: strong risk appetite, possibly complacent' },
      { label: '3–4%', from: 3, to: 4, meaning: 'Calm, healthy credit market' },
      { label: '4–5%', from: 4, to: 5, meaning: 'Around the long-run average (about 5%)' },
      { label: '5–7%', from: 5, to: 7, meaning: 'Stress: slowdown worries (2022 peaked near 6%)' },
      { label: '7–10%', from: 7, to: 10, meaning: 'Recession pricing' },
      { label: 'Above 10%', from: 10, to: Infinity, meaning: 'Crisis (March 2020 about 11%, 2008 about 20%)' },
    ],
  },
  credit_ig: {
    about: 'Falling (tightening): risk appetite growing. Rising (widening): worry is reaching even strong companies, a broader warning than HY alone.',
    bands: [
      { label: 'Below 1%', from: -Infinity, to: 1, meaning: 'Tight, calm' },
      { label: '1–1.5%', from: 1, to: 1.5, meaning: 'Normal (long-run average about 1.3–1.5%)' },
      { label: '1.5–2%', from: 1.5, to: 2, meaning: 'Stress' },
      { label: '2–3%', from: 2, to: 3, meaning: 'Recession pricing' },
      { label: 'Above 3%', from: 3, to: Infinity, meaning: 'Crisis (March 2020 about 4%, 2008 about 6%)' },
    ],
  },
}

/** Cards without an info box, and single-line cards drawn in the pale blue (none at the moment). */
const NO_INFO = new Set(['vix'])
const PALE = new Set<string>()

/** Curve and credit cards name the spread instead of "Current" and leave out the standard deviation. */
const CURRENT_LABEL: Record<string, string> = { curve: '2s10s', curve_3m: '3m10y', credit: 'HY', credit_ig: 'IG' }

type Range = '1M' | '6M' | '1Y' | 'All'
const MONTHS_BACK: Record<Range, number> = { '1M': 1, '6M': 6, '1Y': 12, All: 1200 }

/** /regime shows the signals, /regime/sectors the sector ETFs against SPY or QQQ. */
export function RegimePage({ path }: { path: string }) {
  return path === '/regime/sectors' ? <SectorsView path={path} /> : <SignalsView path="/regime" />
}

function SignalsView({ path }: { path: string }) {
  const [data, setData] = useState<Regime | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    regimeApi.get().then((r) => { setData(r); setError(null) }).catch((e: Error) => setError(e.message))
  }, [])
  useEffect(load, [load])
  // Reload: pull fresh data from the sources, not just re-read what is stored
  const [collecting, setCollecting] = useState(false)
  const collect = useCallback(() => {
    setCollecting(true)
    regimeApi.collect()
      .then((r) => { setData(r); setError(null) })
      .catch((e: Error) => setError(e.message))
      .finally(() => setCollecting(false))
  }, [])
  // the collector runs every 15 minutes; pick up its results without a reload
  useEffect(() => {
    const id = window.setInterval(() => { if (!document.hidden) load() }, 60_000)
    return () => window.clearInterval(id)
  }, [load])

  const header = (
    <RegimeHeader path={path} run={data?.last_run} collecting={collecting} onReload={data ? collect : undefined}
      reloadTitle="Fetch fresh data from FRED, CBOE and ISM now" />
  )
  if (error && !data) return <>{header}<ErrorNote message={error} onRetry={load} /></>
  if (!data) return <>{header}<PageSkeleton /></>
  const byKey = new Map(data.signals.map((s) => [s.key, s]))

  return (
    <>
      {header}
      {error && <ErrorNote message={error} />}
      <ScoreBreakdown score={data.score} />

      <section aria-label="Regime signals" className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {data.signals.map((s) => <SignalChart key={s.key} s={s} />)}
      </section>

      <section aria-labelledby="routing-h">
        <h2 id="routing-h" className="text-[15px] font-semibold tracking-tight">Regime-to-sector routing</h2>
        <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-ink-3">
          Each card counts the signals pointing to it. There is no rule for combining signals into one regime, so
          the call is yours.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {ROUTING.map((r) => {
            const votes = data.votes[r.key] ?? []
            return (
              <div key={r.key} className={`panel p-4 ${votes.length ? 'bg-surface-2 ring-1 ring-[#4d94ff]/50' : ''}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-[14px] font-semibold tracking-tight">{data.regimes[r.key]}</h3>
                  <span className={`num text-xs ${votes.length ? 'text-ink' : 'text-ink-3'}`}>
                    {votes.length} of {data.signals.length}
                  </span>
                </div>
                {votes.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {votes.map((k) => (
                      <span key={k} className="rounded-[3px] border border-line-strong px-1.5 py-px text-[11px] text-ink-2">
                        {byKey.get(k)?.title ?? k}
                      </span>
                    ))}
                  </div>
                )}
                <dl className="mt-3 space-y-1.5 text-[12px] leading-relaxed">
                  <div><dt className="inline text-ink-3">Long: </dt><dd className="inline text-ink-2">{r.long}</dd></div>
                  <div><dt className="inline text-ink-3">Short: </dt><dd className="inline text-ink-2">{r.short}</dd></div>
                  <div><dt className="inline text-ink-3">Options: </dt><dd className="inline text-ink-2">{r.options}</dd></div>
                </dl>
                {r.note && <p className="mt-2 text-[11px] text-ink-3">{r.note}</p>}
              </div>
            )
          })}
        </div>
      </section>
    </>
  )
}

const SCORE_TEXT = { 'Risk-on': 'text-pos', Neutral: 'text-ink', 'Risk-off': 'text-neg' } as const

function signedNum(v: number, digits = 0) {
  return `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(digits)}`
}

/** Each of the five signals, its readings and its share of the score; equal weights, so each can move it by up to 100 / n. */
function ScoreBreakdown({ score }: { score: Regime['score'] | undefined }) {
  if (!score || score.value == null || !score.label || !score.parts.length) return null  // also an API from before the score
  const n = score.parts.length
  return (
    <section aria-label="How the regime score is made up" className="panel p-4">
      <h2 className={`flex items-baseline gap-3 px-3 text-2xl font-semibold tracking-[-0.02em] ${SCORE_TEXT[score.label]}`}>
        {score.label}
        <span className="num text-ink-2">{signedNum(score.value)}</span>
      </h2>
      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-sm)] bg-line md:grid-cols-3 xl:grid-cols-5">
        {score.parts.map((p) => {
          const contribution = (p.points / n) * 100
          return (
            <div key={p.key} className="flex flex-col bg-surface px-3 py-2.5">
              <div className="text-[12px] text-ink-3">{p.title}</div>
              {p.members.map((m) => (
                <div key={m.key} className="mt-0.5 truncate text-[12px] text-ink-2" title={m.reading}>
                  {m.label && <span className="text-ink-3">{m.label}: </span>}{m.reading}
                </div>
              ))}
              <div className={`num mt-auto pt-1 text-[15px] font-semibold ${contribution > 0 ? 'text-pos' : p.points <= -1 ? 'text-neg' : contribution < 0 ? 'text-warn' : 'text-ink-3'}`}>
                {signedNum(contribution, 1)}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function SignalChart({ s }: { s: RegimeSignal }) {
  const [range, setRange] = useState<Range>('6M')
  const { ref, full, slot, toggle: toggleFull, close } = useExpand()

  const lines = useMemo(() => {
    const last = s.series[0]?.points.at(-1)?.[0]
    if (!last) return []
    const d = new Date(last + 'T00:00:00Z')
    d.setUTCMonth(d.getUTCMonth() - MONTHS_BACK[range])
    const cut = d.toISOString().slice(0, 10)
    return s.series.map((l) => ({ ...l, points: l.points.filter((p) => p[0] >= cut) }))
  }, [s.series, range])

  // curve cards draw the short and long yields, so their mean is of the gap between them, matched by date
  const ys = useMemo(() => {
    if (!s.key.startsWith('curve') || lines.length < 2) return lines[0]?.points.map((p) => p[1]) ?? []
    const long = new Map(lines[1].points)
    return lines[0].points.flatMap(([d, v]) => (long.has(d) ? [long.get(d)! - v] : []))
  }, [lines, s.key])
  const mean = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null
  const sd = mean != null ? Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length) : null
  const right = s.series.find((l) => l.axis === 'right')
  const guide = GUIDES[s.key]
  // curve cards: the gap between the two drawn yields on their latest common date, so it matches the values shown
  const gap = s.key.startsWith('curve') && s.series.length > 1
    ? (() => {
        const long = new Map(s.series[1].points)
        const last = [...s.series[0].points].reverse().find(([d]) => long.has(d))
        return last ? long.get(last[0])! - last[1] : null
      })()
    : null

  const card = (
    <article ref={ref} role={full ? 'dialog' : undefined} aria-modal={full || undefined} aria-label={full ? s.title : undefined}
      className={cardClass(full)}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[16px] font-medium tracking-tight text-ink">{s.title}</h2>
            {!NO_INFO.has(s.key) && <div className="group relative inline-flex">
              <button type="button" aria-label={`How ${s.title} is read`} className="inline-flex text-ink-3 hover:text-ink-2">
                <Info size={15} />
              </button>
              <div role="tooltip"
                className={`invisible absolute left-0 top-6 z-20 ${guide ? 'w-[480px]' : 'w-[380px]'} max-w-[80vw] rounded-[var(--radius-md)] border border-line-strong bg-surface-2 p-3 text-[12px] leading-relaxed text-ink-2 opacity-0 shadow-xl transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100`}>
                {guide && (
                  <>
                    <p>{guide.about}</p>
                    {guide.read && (
                      <>
                        <p className="mt-2 text-ink">Reading the chart</p>
                        <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                          {guide.read.map((r) => <li key={r}>{r}</li>)}
                        </ul>
                      </>
                    )}
                    <table className="mt-2 w-full border-collapse text-[11.5px]">
                      <thead className="text-left text-ink-3">
                        <tr className="border-b border-line"><th className="py-1 pr-3 font-normal">{guide.columns?.[0] ?? 'Level'}</th><th className="py-1 font-normal">{guide.columns?.[1] ?? 'What it usually means'}</th></tr>
                      </thead>
                      <tbody>
                        {guide.bands.map((band) => {
                          const here = band.reading ? band.reading(s.reading ?? '')
                            : s.value != null && s.value >= (band.from ?? -Infinity) && s.value < (band.to ?? Infinity)
                          return (
                            <tr key={band.label} className={`border-b border-line last:border-b-0 ${here ? 'text-ink' : ''}`}>
                              <td className="num whitespace-nowrap py-1 pr-3">{band.label}{here && <span className="ml-1.5 text-[#4d94ff]">now</span>}</td>
                              <td className="py-1">{band.meaning}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </>
                )}
                <p className={guide ? 'mt-2 border-t border-line pt-2' : ''}><span className="text-ink">Rule:</span> {s.rule}</p>
                <p className="mt-1.5 text-ink-3">{s.source} · {s.cadence}</p>
              </div>
            </div>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={`inline-flex items-center gap-1.5 text-[13px] font-medium ${TONE_TEXT[s.tone]}`}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[s.tone]}`} />
              {s.reading ?? 'Not enough data yet'}
            </span>
            {/* the date the reading is based on; when the reading itself last changed shows only when expanded */}
            {s.as_of && (
              <span className="text-[11px] text-ink-3">
                {/* ISM figures cover a month and are stored on its first day */}
                {s.key.startsWith('ism') ? `data for ${MONTH_FMT.format(new Date(s.as_of + 'T12:00:00Z'))}` : `data to ${date(s.as_of + 'T12:00:00Z')}`}
              </span>
            )}
            {full && s.reading_since && <span className="text-[11px] text-ink-3">· reading since {dateTime(s.reading_since)}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Segmented<Range> label="Range" value={range} onChange={setRange}
            options={(['1M', '6M', '1Y', 'All'] as const).map((r) => ({ value: r, label: r }))} />
          <ExpandButton full={full} onClick={toggleFull} />
        </div>
      </header>

      <div className={`mt-4 ${full ? 'h-[500px]' : 'min-h-0 flex-1'}`}>
        <RegimeChart lines={lines} levels={s.levels} format={(v) => fmt(v, s.unit)}
          formatRight={right ? (v) => fmt(v, right.unit) : undefined} fillGap={s.key.startsWith('curve')} pale={PALE.has(s.key)}
          ariaLabel={`${s.title}, ${range}`} />
      </div>

      {/* closed: only each line's latest value and its key; open: everything */}
      {!full && (
        <footer className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-3">
          {s.series.map((l, i) => (
            <span key={l.label} className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded" style={{ background: lineColor(i, s.series.length, PALE.has(s.key)) }} />
              {l.label}{l.axis === 'right' ? ' (right axis)' : ''}:
              <span className="num text-ink">{fmt(l.points.at(-1)?.[1] ?? null, l.unit)}</span>
            </span>
          ))}
          {gap != null && (
            <span>Spread: <span className={`num ${gap < 0 ? 'text-neg' : 'text-ink'}`}>{fmt(gap, s.unit)}</span></span>
          )}
        </footer>
      )}
      {full && (
        <>
          <footer className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-[12px]">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-ink-3">
              <span>{CURRENT_LABEL[s.key] ?? 'Current'}: <span className="num text-ink">{fmt(s.value, s.unit)}</span></span>
              <span>Mean: <span className="num text-ink-2">{fmt(mean, s.unit)}</span></span>
              {!CURRENT_LABEL[s.key] && <span>Std dev: <span className="num text-ink-2">{fmt(sd, s.unit)}</span></span>}
              {s.lines.map((l) => (
                <span key={l.label}>{l.label}: <span className="num text-ink-2">{fmt(l.value, l.unit, l.label.toLowerCase().includes('change'))}</span></span>
              ))}
            </div>
            <div className="flex gap-3 text-ink-3">
              {s.series.map((l, i) => (
                <span key={l.label} className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3 rounded" style={{ background: lineColor(i, s.series.length, PALE.has(s.key)) }} />
                  {l.label}{l.axis === 'right' ? ' (right axis)' : ''}
                </span>
              ))}
            </div>
          </footer>
          {s.notes.map((n) => <p key={n} className="mt-2 text-[12px] leading-relaxed text-warn">{n}</p>)}
          {s.as_of && <p className="mt-1 text-[11px] text-ink-3">Latest figure {s.as_of}, collected {ago(s.received)}.</p>}
        </>
      )}
    </article>
  )
  return <ExpandOverlay full={full} slot={slot} onClose={close}>{card}</ExpandOverlay>
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-10 w-56" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Skeleton className="h-[450px]" />
        <Skeleton className="h-[450px]" />
      </div>
    </div>
  )
}
