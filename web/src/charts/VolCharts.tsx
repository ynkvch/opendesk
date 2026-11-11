import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { linear, niceTicks } from './util'

/** series colours for the vol charts: periwinkle, lavender, tan, sky, then the regime blues. */
export const VOL_COLORS = ['#8fa3ee', '#b8a7f4', '#dcbf8b', '#4fb3ef', '#bfd8ff', '#518eed']
const PAD = { top: 14, right: 18, bottom: 30, left: 60 }

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

function yScale(values: number[], h: number, extra: number[] = []) {
  const ys = [...values, ...extra]
  let lo = Math.min(...ys)
  let hi = Math.max(...ys)
  const m = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1
  lo -= m
  hi += m
  const ticks = niceTicks(lo, hi, Math.max(3, Math.round(h / 80))).filter((v) => v >= lo && v <= hi)
  return { sy: linear(lo, hi, h - PAD.bottom, PAD.top), ticks }
}

function Tip({ x, w, children }: { x: number; w: number; children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute top-2 z-10 rounded-[var(--radius-sm)] border border-line-strong bg-surface-2/95 px-2.5 py-1.5 text-xs shadow-lg"
      style={x > w / 2 ? { right: w - x + 12 } : { left: x + 12 }}>
      {children}
    </div>
  )
}

function Swatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return dashed
    ? <span className="w-3 border-t border-dashed" style={{ borderColor: color }} />
    : <span className="h-2 w-2 rounded-full" style={{ background: color }} />
}

/** the legend under each chart: a dot per series with its latest value, centred like the reference charts. */
export function Legend({ items }: { items: { label: string; value?: ReactNode; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-6 gap-y-1 text-[12px] text-ink-2">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-2">
          <Swatch color={it.color} dashed={it.dashed} />
          {it.label}
          {it.value != null && <span className="num text-ink">{it.value}</span>}
        </span>
      ))}
    </div>
  )
}

export type Series = { label: string; points: [string, number][]; color: string; dashed?: boolean }

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')

/** a smooth path through the points that never overshoots them (monotone cubic, as in d3's curveMonotoneX). */
function monotonePath(pts: [number, number][]): string {
  const n = pts.length
  if (n < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i][0])
  const slope = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / (dx[i] || 1))
  const m = pts.map((_, i) => {
    if (i === 0) return slope[0]
    if (i === n - 1) return slope[n - 2]
    const a = slope[i - 1]
    const b = slope[i]
    return a * b <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / a + (dx[i] + 2 * dx[i - 1]) / b)
  })
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    d += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + m[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - m[i + 1] * h).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`
  }
  return d
}

/** a centred moving average over `span` points, kept inside each session so one day's close doesn't bleed into the next. */
function smoothWithin<T>(items: T[], value: (t: T) => number, group: (t: T) => string, span = 3): number[] {
  const half = Math.floor(span / 2)
  return items.map((it, i) => {
    let sum = 0
    let n = 0
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= items.length || group(items[j]) !== group(it)) continue
      sum += value(items[j])
      n++
    }
    return sum / n
  })
}

/**
 * time series on dashed gridlines. x is dates (YYYY-MM-DD) or times (iso); levels draw dashed rules such as the
 * median; zeroFill shades the first series green above zero and red below.
 */
export function SeriesChart({ series, levels = [], format, zeroFill = false, time = false, ariaLabel }: {
  series: Series[]
  levels?: { value: number; label: string }[]
  format: (v: number) => string
  zeroFill?: boolean
  time?: boolean
  ariaLabel: string
}) {
  const [ref, { w, h }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const ms = (d: string) => Date.parse(time ? d : `${d}T00:00:00Z`)

  const geo = useMemo(() => {
    const all = series.flatMap((s) => s.points)
    if (!w || !h || all.length < 2) return null
    const x0 = Math.min(...all.map((p) => ms(p[0])))
    const x1 = Math.max(...all.map((p) => ms(p[0])))
    const sx = linear(x0, x1, PAD.left, w - PAD.right)
    const y = yScale(all.map((p) => p[1]), h, [...levels.map((l) => l.value), ...(zeroFill ? [0] : [])])
    const path = (pts: [string, number][]) => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(ms(p[0])).toFixed(1)},${y.sy(p[1]).toFixed(1)}`).join('')
    let fill: { d: string; neg: boolean }[] = []
    if (zeroFill && series[0]?.points.length > 1) {
      // split the area at each zero crossing so every piece has one colour
      const pts = series[0].points.map((p) => ({ x: sx(ms(p[0])), v: p[1] }))
      const z = y.sy(0)
      let run: { x: number; v: number }[] = []
      const flush = () => {
        if (run.length > 1) {
          fill.push({ d: `M${run[0].x},${z}` + run.map((p) => `L${p.x.toFixed(1)},${y.sy(p.v).toFixed(1)}`).join('') + `L${run[run.length - 1].x},${z}Z`,
            neg: run.some((p) => p.v < 0) })
        }
      }
      pts.forEach((p, i) => {
        const prev = pts[i - 1]
        if (prev && prev.v * p.v < 0) {
          const cross = { x: prev.x + ((p.x - prev.x) * prev.v) / (prev.v - p.v), v: 0 }
          run.push(cross)
          flush()
          run = [cross]
        }
        run.push(p)
      })
      flush()
    } else fill = []
    const span = (x1 - x0) / 86_400_000
    const n = Math.max(2, Math.min(7, Math.round(w / 150)))
    const xticks = Array.from({ length: n }, (_, i) => x0 + ((x1 - x0) * i) / (n - 1))
    const label = (v: number) => {
      const d = new Date(v)
      if (time) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      return span > 300 ? `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
    }
    return { sx, ...y, paths: series.map((s) => path(s.points)), fill, xticks, label, x0, x1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, levels, zeroFill, w, h, time])

  const base = series[0]?.points ?? []
  const nearest = (px: number) => {
    if (!geo || !base.length) return null
    const target = geo.x0 + ((px - PAD.left) / (w - PAD.left - PAD.right)) * (geo.x1 - geo.x0)
    let best = 0
    base.forEach((p, i) => { if (Math.abs(ms(p[0]) - target) < Math.abs(ms(base[best][0]) - target)) best = i })
    return best
  }
  const at = hover != null ? base[hover] : null
  const valueOn = (s: Series, d: string) => {
    let v: number | null = null
    for (const p of s.points) { if (ms(p[0]) > ms(d)) break; v = p[1] }
    return v
  }

  return (
    <div ref={ref} className="relative h-full w-full select-none">
      {geo && (
        <svg width={w} height={h} role="img" aria-label={ariaLabel} className="block"
          onMouseMove={(e) => setHover(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left))}
          onMouseLeave={() => setHover(null)}>
          {geo.ticks.map((v) => (
            <g key={v}>
              {v === 0 && <line x1={PAD.left} x2={w - PAD.right} y1={geo.sy(v)} y2={geo.sy(v)} stroke="rgb(255 255 255 / 0.22)" />}
              <text x={PAD.left - 10} y={geo.sy(v)} dy="0.32em" textAnchor="end" className="num fill-ink-3 font-mono text-[11px]">{format(v)}</text>
            </g>
          ))}
          <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={h - PAD.bottom} stroke="rgb(255 255 255 / 0.14)" />
          <line x1={PAD.left} x2={w - PAD.right} y1={h - PAD.bottom} y2={h - PAD.bottom} stroke="rgb(255 255 255 / 0.14)" />
          {geo.xticks.map((x, i) => (
            <text key={x} x={geo.sx(x)} y={h - 9} textAnchor={i === 0 ? 'start' : i === geo.xticks.length - 1 ? 'end' : 'middle'}
              className="num fill-ink-3 font-mono text-[11px]">{geo.label(x)}</text>
          ))}
          {geo.fill.map((f, i) => (
            <path key={i} d={f.d} fill={f.neg ? 'rgb(229 100 92 / 0.16)' : 'rgb(79 191 130 / 0.14)'} />
          ))}
          {levels.map((l) => (
            <g key={l.label}>
              <line x1={PAD.left} x2={w - PAD.right} y1={geo.sy(l.value)} y2={geo.sy(l.value)} stroke="rgb(255 255 255 / 0.7)" strokeDasharray="6 5" />
              <text x={w - PAD.right - 4} y={geo.sy(l.value) - 6} textAnchor="end" className="fill-ink-2 text-[10px]">{l.label} {format(l.value)}</text>
            </g>
          ))}
          {geo.paths.map((d, i) => (
            <path key={series[i].label} d={d} fill="none" stroke={series[i].color} strokeWidth={1.4}
              strokeDasharray={series[i].dashed ? '2 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {at && <line x1={geo.sx(ms(at[0]))} x2={geo.sx(ms(at[0]))} y1={PAD.top} y2={h - PAD.bottom} stroke="rgb(255 255 255 / 0.25)" />}
        </svg>
      )}
      {geo && at && (
        <Tip x={geo.sx(ms(at[0]))} w={w}>
          <div className="text-ink-3">{time ? new Date(at[0]).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : at[0]}</div>
          {series.map((s) => {
            const v = valueOn(s, at[0])
            return v == null ? null : (
              <div key={s.label} className="num mt-0.5 flex items-center gap-2 text-ink"><Swatch color={s.color} dashed={s.dashed} />{s.label} {format(v)}</div>
            )
          })}
        </Tip>
      )}
    </div>
  )
}

/**
 * curves over a numeric x (days to expiry) or named points (delta buckets), a dot on every point and dashed
 * gridlines both ways, like a futures curve or a skew structure.
 */
export function CurveChart({ series, categories, xFormat = String, format, ariaLabel }: {
  series: { label: string; color: string; points: [number, number | null][] }[]
  /** named x positions; point x values are then indexes into this list */
  categories?: string[]
  xFormat?: (v: number) => string
  format: (v: number) => string
  ariaLabel: string
}) {
  const [ref, { w, h }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const geo = useMemo(() => {
    const pts = series.flatMap((s) => s.points.filter((p): p is [number, number] => p[1] != null))
    if (!w || !h || pts.length < 2) return null
    const xs = categories ? categories.map((_, i) => i) : pts.map((p) => p[0])
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    const inset = categories ? 40 : 10
    const sx = linear(x0, x1, PAD.left + inset, w - PAD.right - inset)
    const y = yScale(pts.map((p) => p[1]), h)
    const xticks = categories ? xs : niceTicks(0, x1, Math.max(3, Math.round(w / 110))).filter((v) => v <= x1 * 1.04)
    const lines = series.map((s) => {
      const ok = s.points.filter((p): p is [number, number] => p[1] != null)
      return { d: ok.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${y.sy(p[1]).toFixed(1)}`).join(''), ok }
    })
    const allX = [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b)
    return { sx, ...y, xticks, lines, allX }
  }, [series, categories, w, h])

  const near = (px: number) => {
    if (!geo) return null
    let best = geo.allX[0]
    for (const x of geo.allX) if (Math.abs(geo.sx(x) - px) < Math.abs(geo.sx(best) - px)) best = x
    return best
  }

  return (
    <div ref={ref} className="relative h-full w-full select-none">
      {geo && (
        <svg width={w} height={h} role="img" aria-label={ariaLabel} className="block"
          onMouseMove={(e) => setHover(near(e.clientX - e.currentTarget.getBoundingClientRect().left))}
          onMouseLeave={() => setHover(null)}>
          {geo.ticks.map((v) => (
            <g key={v}>
              <text x={PAD.left - 10} y={geo.sy(v)} dy="0.32em" textAnchor="end" className="num fill-ink-3 font-mono text-[11px]">{format(v)}</text>
            </g>
          ))}
          {geo.xticks.map((x) => (
            <g key={x}>
              <text x={geo.sx(x)} y={h - 9} textAnchor="middle" className="num fill-ink-3 font-mono text-[11px]">
                {categories ? categories[x] : xFormat(x)}
              </text>
            </g>
          ))}
          <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={h - PAD.bottom} stroke="rgb(255 255 255 / 0.14)" />
          <line x1={PAD.left} x2={w - PAD.right} y1={h - PAD.bottom} y2={h - PAD.bottom} stroke="rgb(255 255 255 / 0.14)" />
          {hover != null && <line x1={geo.sx(hover)} x2={geo.sx(hover)} y1={PAD.top} y2={h - PAD.bottom} stroke="rgb(255 255 255 / 0.25)" />}
          {geo.lines.map((l, i) => (
            <g key={series[i].label}>
              <path d={l.d} fill="none" stroke={series[i].color} strokeWidth={1.4} strokeLinejoin="round" />
              {l.ok.map((p) => (
                <circle key={p[0]} cx={geo.sx(p[0])} cy={geo.sy(p[1])} r={hover === p[0] ? 4 : 2.75} fill={series[i].color} />
              ))}
            </g>
          ))}
        </svg>
      )}
      {geo && hover != null && (
        <Tip x={geo.sx(hover)} w={w}>
          <div className="text-ink-3">{categories ? categories[hover] : xFormat(hover)}</div>
          {series.map((s) => {
            const p = s.points.find((q) => q[0] === hover)
            return p?.[1] == null ? null : (
              <div key={s.label} className="num mt-0.5 flex items-center gap-2 text-ink"><Swatch color={s.color} />{s.label} {format(p[1])}</div>
            )
          })}
        </Tip>
      )}
    </div>
  )
}

/** a strike ladder: strikes down the left (highest at the top), calls to the right in green, puts to the left in red, spot as a dashed rule. */
export function FlowBars({ rows, spot, format, ariaLabel }: {
  rows: { strike: number; calls: number; puts: number }[]
  spot: number
  format: (v: number) => string
  ariaLabel: string
}) {
  const [ref, { w, h }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const pad = { top: 8, right: 16, bottom: 28, left: 56 }
  const ladder = useMemo(() => [...rows].sort((a, b) => b.strike - a.strike), [rows])

  const geo = useMemo(() => {
    if (!w || !h || !ladder.length) return null
    const most = Math.max(1, ...ladder.map((r) => Math.max(r.calls, r.puts)))
    const ticks = niceTicks(0, most, 3).filter((v) => v > 0 && v <= most * 1.05)
    const mid = pad.left + (w - pad.left - pad.right) / 2
    const half = (w - pad.left - pad.right) / 2
    const sx = (v: number) => (v / most) * half * 0.96
    const band = (h - pad.top - pad.bottom) / ladder.length
    const sy = (i: number) => pad.top + band * (i + 0.5)
    // spot sits between the strikes around it (the ladder runs high to low)
    const j = ladder.findIndex((r) => r.strike <= spot)
    const spotY = j <= 0 ? sy(Math.max(j, 0)) : sy(j - 1) + ((ladder[j - 1].strike - spot) / (ladder[j - 1].strike - ladder[j].strike)) * band
    const every = Math.max(1, Math.ceil(14 / band))
    return { mid, sx, band, sy, spotY, every, ticks }
  }, [ladder, spot, w, h])

  const r = hover != null ? ladder[hover] : null
  return (
    <div ref={ref} className="relative h-full w-full select-none">
      {geo && (
        <svg width={w} height={h} role="img" aria-label={ariaLabel} className="block"
          onMouseMove={(e) => {
            const i = Math.floor((e.clientY - e.currentTarget.getBoundingClientRect().top - pad.top) / geo.band)
            setHover(i >= 0 && i < ladder.length ? i : null)
          }}
          onMouseLeave={() => setHover(null)}>
          <line x1={geo.mid} x2={geo.mid} y1={pad.top} y2={h - pad.bottom} stroke="rgb(255 255 255 / 0.22)" />
          {[...geo.ticks.map((v) => -v), 0, ...geo.ticks].map((v) => (
            <text key={v} x={geo.mid + (v < 0 ? -geo.sx(-v) : geo.sx(v))} y={h - 9} textAnchor="middle" className="num fill-ink-3 font-mono text-[11px]">
              {format(Math.abs(v))}
            </text>
          ))}
          {ladder.map((row, i) => {
            const bh = Math.max(1, geo.band * 0.7)
            const y = geo.sy(i) - bh / 2
            return (
              <g key={row.strike} opacity={hover == null || hover === i ? 1 : 0.55}>
                {row.calls > 0 && <rect x={geo.mid} y={y} width={geo.sx(row.calls)} height={bh} fill="var(--color-pos)" opacity={0.8} />}
                {row.puts > 0 && <rect x={geo.mid - geo.sx(row.puts)} y={y} width={geo.sx(row.puts)} height={bh} fill="var(--color-neg)" opacity={0.8} />}
                {i % geo.every === 0 && (
                  <text x={pad.left - 10} y={geo.sy(i)} dy="0.32em" textAnchor="end" className="num fill-ink-3 font-mono text-[11px]">{row.strike}</text>
                )}
              </g>
            )
          })}
          <line x1={pad.left} x2={w - pad.right} y1={geo.spotY} y2={geo.spotY} stroke="rgb(255 255 255 / 0.6)" strokeDasharray="4 4" />
          <text x={w - pad.right} y={geo.spotY - 5} textAnchor="end" className="fill-ink-2 text-[10px]">spot {spot.toFixed(2)}</text>
          <text x={pad.left} y={pad.top + 2} dy="0.7em" className="fill-ink-3 text-[10px]">Puts</text>
          <text x={w - pad.right} y={pad.top + 2} dy="0.7em" textAnchor="end" className="fill-ink-3 text-[10px]">Calls</text>
        </svg>
      )}
      {geo && r && (
        <div className="pointer-events-none absolute z-10 rounded-[var(--radius-sm)] border border-line-strong bg-surface-2/95 px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: pad.left + 8, top: Math.min(Math.max(geo.sy(hover!) - 30, 0), h - 80) }}>
          <div className="text-ink-3">Strike {r.strike}</div>
          <div className="num mt-0.5 flex items-center gap-2 text-ink"><Swatch color="var(--color-pos)" />Calls {format(r.calls)}</div>
          <div className="num mt-0.5 flex items-center gap-2 text-ink"><Swatch color="var(--color-neg)" />Puts {format(r.puts)}</div>
        </div>
      )}
    </div>
  )
}

/**
 * past sessions, one point per 30 minutes: call flow as a green line, put flow as a red line (each averaged with the
 * half-hours either side and drawn as a smooth curve), the share price as a white line on its own axis, sessions
 * split by faint rules. nights and weekends are left out so the sessions sit
 * side by side.
 */
export function SessionFlowChart({ bars, format, priceFormat, ariaLabel }: {
  bars: { time: string; day: string; calls: number; puts: number; price: number }[]
  format: (v: number) => string
  priceFormat: (v: number) => string
  ariaLabel: string
}) {
  const [ref, { w, h }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const right = 60
  const PRICE = '#ececea'

  const geo = useMemo(() => {
    if (!w || !h || bars.length < 2) return null
    // each line is the average of a half-hour and its neighbours in the same session, so single spikes don't
    // dominate; the tooltip still shows the raw half-hour
    const calls = smoothWithin(bars, (b) => b.calls, (b) => b.day)
    const puts = smoothWithin(bars, (b) => b.puts, (b) => b.day)
    const y = yScale([...calls, ...puts], h, [0])
    const prices = bars.map((b) => b.price)
    let lo = Math.min(...prices)
    let hi = Math.max(...prices)
    const m = (hi - lo) * 0.08 || hi * 0.01
    lo -= m
    hi += m
    const py = linear(lo, hi, h - PAD.bottom, PAD.top)
    const pticks = niceTicks(lo, hi, 5).filter((v) => v >= lo && v <= hi)
    // one slot per half-hour, the point in the middle of its slot
    const step = (w - PAD.left - right) / bars.length
    const sx = (i: number) => PAD.left + step * (i + 0.5)
    const days: { day: string; from: number; to: number }[] = []
    bars.forEach((b, i) => {
      const last = days[days.length - 1]
      if (last && last.day === b.day) last.to = i
      else days.push({ day: b.day, from: i, to: i })
    })
    return { ...y, py, pticks, step, sx, days, calls: monotonePath(calls.map((v, i) => [sx(i), y.sy(v)])), puts: monotonePath(puts.map((v, i) => [sx(i), y.sy(v)])),
      price: monotonePath(bars.map((b, i) => [sx(i), py(b.price)])), smooth: { calls, puts } }
  }, [bars, w, h])

  const b = hover != null ? bars[hover] : null
  const dayLabel = (d: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).format(new Date(`${d}T12:00:00Z`))
  return (
    <div ref={ref} className="relative h-full w-full select-none">
      {geo && (
        <svg width={w} height={h} role="img" aria-label={ariaLabel} className="block"
          onMouseMove={(e) => {
            const i = Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - PAD.left) / geo.step)
            setHover(i >= 0 && i < bars.length ? i : null)
          }}
          onMouseLeave={() => setHover(null)}>
          {geo.ticks.map((v) => (
            <text key={v} x={PAD.left - 10} y={geo.sy(v)} dy="0.32em" textAnchor="end" className="num fill-ink-3 font-mono text-[11px]">{format(v)}</text>
          ))}
          {geo.pticks.map((v) => (
            <text key={`p${v}`} x={w - right + 10} y={geo.py(v)} dy="0.32em" className="num fill-ink-2 font-mono text-[11px]">{priceFormat(v)}</text>
          ))}
          <line x1={PAD.left} x2={w - right} y1={h - PAD.bottom} y2={h - PAD.bottom} stroke="rgb(255 255 255 / 0.14)" />
          {geo.days.map((d, k) => (
            <g key={d.day}>
              {k > 0 && <line x1={geo.sx(d.from) - geo.step / 2} x2={geo.sx(d.from) - geo.step / 2} y1={PAD.top} y2={h - PAD.bottom}
                stroke="rgb(255 255 255 / 0.08)" />}
              <text x={(geo.sx(d.from) + geo.sx(d.to)) / 2} y={h - 9} textAnchor="middle" className="num fill-ink-3 font-mono text-[11px]">{dayLabel(d.day)}</text>
            </g>
          ))}
          <path d={geo.calls} fill="none" stroke="var(--color-pos)" strokeWidth={1.6} strokeLinejoin="round" />
          <path d={geo.puts} fill="none" stroke="var(--color-neg)" strokeWidth={1.6} strokeLinejoin="round" />
          <path d={geo.price} fill="none" stroke={PRICE} strokeWidth={1.75} strokeLinejoin="round" />
          {b && (
            <g pointerEvents="none">
              <line x1={geo.sx(hover!)} x2={geo.sx(hover!)} y1={PAD.top} y2={h - PAD.bottom} stroke="rgb(255 255 255 / 0.25)" />
              <circle cx={geo.sx(hover!)} cy={geo.sy(geo.smooth.calls[hover!])} r={3.5} fill="var(--color-pos)" />
              <circle cx={geo.sx(hover!)} cy={geo.sy(geo.smooth.puts[hover!])} r={3.5} fill="var(--color-neg)" />
              <circle cx={geo.sx(hover!)} cy={geo.py(b.price)} r={3.5} fill={PRICE} />
            </g>
          )}
        </svg>
      )}
      {geo && b && (
        <Tip x={geo.sx(hover!)} w={w}>
          <div className="text-ink-3">{dayLabel(b.day)}, {new Date(b.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })} New York</div>
          <div className="num mt-0.5 flex items-center gap-2 text-ink"><Swatch color="var(--color-pos)" />Calls {format(b.calls)}</div>
          <div className="num mt-0.5 flex items-center gap-2 text-ink"><Swatch color="var(--color-neg)" />Puts {format(b.puts)}</div>
          <div className="num mt-0.5 flex items-center gap-2 text-ink"><Swatch color={PRICE} />Price {priceFormat(b.price)}</div>
        </Tip>
      )}
    </div>
  )
}
