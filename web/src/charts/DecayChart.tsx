import { useMemo, useState } from 'react'
import type { ThetaClose, ThetaDay } from '../lib/api'
import { date, dateTime, money, num, vol } from '../lib/format'
import { linear, niceTicks, useWidth } from './util'

type Props = {
  history: ThetaClose[]
  projection: ThetaDay[]
  /** vertical reference lines; their meaning is explained outside the chart */
  markers?: { date: string; color: string }[]
  /** readings each hour (three days or less to expiry) instead of each close */
  hourly?: boolean
  ariaLabel: string
}

type Day = {
  date: string
  x: number
  extrinsic: number
  /** USD of extrinsic value theta takes that day (positive = lost) */
  eaten: number | null
  actual: boolean
  close?: ThetaClose
}

const PAD = { top: 12, right: 12, left: 56 }
const TOP_H = 200
const GAP = 34
const BAR_H = 80
const AXIS_H = 22
const HEIGHT = PAD.top + TOP_H + GAP + BAR_H + AXIS_H
const DAY_MS = 86_400_000

/**
 * Top: extrinsic value of the position at each session close (solid), then projected to expiry
 * with the underlying and IV held at the last close (dashed). Bottom: dollars theta takes per day.
 */
export function DecayChart({ history, projection, markers = [], hourly = false, ariaLabel }: Props) {
  const label = hourly ? dateTime : date
  const per = hourly ? 'hour' : 'day'
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const t0 = new Date(history[0]?.date ?? projection[0]?.date).getTime()
  const days = useMemo<Day[]>(() => {
    const x = (d: string) => (new Date(d).getTime() - t0) / DAY_MS
    return [
      ...history.map((h) => ({ date: h.date, x: x(h.date), extrinsic: h.extrinsic, eaten: h.theta == null ? null : -h.theta, actual: true, close: h })),
      ...projection.map((p) => ({ date: p.date, x: x(p.date), extrinsic: p.extrinsic, eaten: p.decay, actual: false })),
    ]
  }, [history, projection, t0])

  // the bars: one per point (daily), or one per clock hour (hourly) so every bar is an hour and the same width.
  // an hour up to the last reading takes the theta of the latest reading in it; a later hour, the projected decay
  // ending at that hour (scaled to a full hour when the step was shorter)
  const bars = useMemo(() => {
    if (!hourly) return days.map((d, i) => ({ x: d.x, eaten: d.eaten, actual: d.actual, from: i, to: i }))
    const HOUR = 1 / 24
    const split = history.length
    const lastActual = split ? days[split - 1].x : -Infinity
    const first = Math.floor((t0 + (days[0]?.x ?? 0) * DAY_MS) / 3_600_000) * 3_600_000
    const end = days[days.length - 1]?.x ?? 0
    const out: { x: number; eaten: number | null; actual: boolean; from: number; to: number }[] = []
    for (let s = (first - t0) / DAY_MS; s < end - 1e-9; s += HOUR) {
      const e = s + HOUR
      const inSlot = days.map((d, i) => [d, i] as const).filter(([d]) => d.x > s - 1e-9 && d.x < e - 1e-9)
      if (s <= lastActual) {
        const latest = days.slice(0, split).filter((d) => d.x < e - 1e-9 && d.eaten != null).at(-1)
        out.push({ x: s + HOUR / 2, eaten: latest?.eaten ?? null, actual: true, from: inSlot[0]?.[1] ?? -1, to: inSlot.at(-1)?.[1] ?? -1 })
      } else {
        const j = days.findIndex((d, i) => i >= split && d.x > s + 1e-9 && d.x <= e + 1e-9)
        if (j < 0) continue
        const prevX = j > 0 ? days[j - 1].x : s
        const covered = Math.min(1, (days[j].x - Math.max(prevX, s)) / HOUR) || 1
        out.push({ x: s + HOUR / 2, eaten: (days[j].eaten ?? 0) / covered, actual: false, from: j, to: j })
      }
    }
    return out
  }, [hourly, days, history.length, t0])

  const geo = useMemo(() => {
    if (!width || days.length < 2) return null
    const xs = days.map((d) => d.x)
    // hourly bars sit on clock hours, which can start before the first reading
    const x0 = hourly && bars.length ? Math.min(xs[0], bars[0].x - 1 / 48) : xs[0]
    const sx = linear(x0, xs[xs.length - 1], PAD.left, width - PAD.right)
    const ext = niceTicks(Math.min(0, ...days.map((d) => d.extrinsic)), Math.max(...days.map((d) => d.extrinsic)), 4)
    const sy = linear(ext[0], ext[ext.length - 1], PAD.top + TOP_H, PAD.top)
    const eaten = niceTicks(0, Math.max(...bars.map((b) => b.eaten ?? 0)), 2)
    const barTop = PAD.top + TOP_H + GAP
    const sb = linear(0, eaten[eaten.length - 1], barTop + BAR_H, barTop)
    const path = (ds: Day[]) => ds.map((d, i) => `${i ? 'L' : 'M'}${sx(d.x).toFixed(1)},${sy(d.extrinsic).toFixed(1)}`).join('')
    const split = history.length
    const past = days.slice(0, split)
    // the projection starts where the last close left off
    const future = days.slice(Math.max(0, split - 1))
    const zero = sy(Math.max(0, ext[0]))
    const area = past.length > 1
      ? `${path(past)}L${sx(past[past.length - 1].x).toFixed(1)},${zero}L${sx(past[0].x).toFixed(1)},${zero}Z` : ''
    // one width for every bar: 60% of the spacing (an hour, or the typical gap between closes)
    const gaps = bars.slice(1).map((b, i) => sx(b.x) - sx(bars[i].x)).filter((g) => g > 0).sort((a, b) => a - b)
    const barW = Math.max(1.5, Math.min(16, (gaps.length ? gaps[Math.floor(gaps.length / 2)] : 16) * 0.6))
    const nl = Math.max(2, Math.min(6, Math.floor((width - PAD.left) / 90)))
    // labels evenly spaced in time, each on the nearest point
    const span = xs[xs.length - 1] - xs[0]
    const nearest = (x: number) => xs.reduce((best, v, i) => (Math.abs(v - x) < Math.abs(xs[best] - x) ? i : best), 0)
    const xl = [...new Set(Array.from({ length: nl }, (_, k) => nearest(xs[0] + (k * span) / (nl - 1))))]
    return { sx, sy, sb, ext, eaten, barTop, past: path(past), future: split < days.length ? path(future) : '', area, barW, xl, split }
  }, [width, days, bars, hourly, history.length])

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    if (!geo) return
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left + PAD.left
    let best = 0
    for (let i = 1; i < days.length; i++) if (Math.abs(geo.sx(days[i].x) - x) < Math.abs(geo.sx(days[best].x) - x)) best = i
    setHover(best)
  }

  const h = hover == null ? null : days[hover]
  const prevActual = hover != null && h?.actual && hover > 0 ? days[hover - 1] : null

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height: HEIGHT }}>
      {geo && (
        <svg width={width} height={HEIGHT} role="img" aria-label={ariaLabel} className="block overflow-visible">
          {geo.ext.map((t) => (
            <g key={`e${t}`}>
              <line x1={PAD.left} x2={width - PAD.right} y1={geo.sy(t)} y2={geo.sy(t)}
                stroke={t === 0 ? 'var(--color-line-strong)' : 'var(--color-line)'} />
              <text x={PAD.left - 10} y={geo.sy(t)} dy="0.32em" textAnchor="end" className="num fill-ink-3 text-[11px]">{money(t)}</text>
            </g>
          ))}
          <text x={PAD.left} y={geo.barTop - 10} className="fill-ink-3 text-[11px]">Taken by theta per {per}</text>
          {geo.eaten.map((t) => (
            <g key={`b${t}`}>
              <line x1={PAD.left} x2={width - PAD.right} y1={geo.sb(t)} y2={geo.sb(t)}
                stroke={t === 0 ? 'var(--color-line-strong)' : 'var(--color-line)'} />
              <text x={PAD.left - 10} y={geo.sb(t)} dy="0.32em" textAnchor="end" className="num fill-ink-3 text-[11px]">{money(t)}</text>
            </g>
          ))}

          {geo.area && <path d={geo.area} fill="var(--color-ink)" fillOpacity={0.06} />}
          {geo.past && <path d={geo.past} fill="none" stroke="var(--color-ink)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />}
          {geo.future && <path d={geo.future} fill="none" stroke="var(--color-ink-2)" strokeWidth={1.5} strokeDasharray="4 3" strokeLinejoin="round" />}
          {geo.split > 0 && geo.split < days.length && (
            <line x1={geo.sx(days[geo.split - 1].x)} x2={geo.sx(days[geo.split - 1].x)} y1={PAD.top} y2={geo.barTop + BAR_H}
              stroke="var(--color-line-strong)" strokeDasharray="2 3" />
          )}

          {markers.map((m) => {
            const d = days.find((x) => x.date === m.date)
            return d && (
              <line key={m.color} x1={geo.sx(d.x)} x2={geo.sx(d.x)} y1={PAD.top} y2={geo.barTop + BAR_H}
                stroke={m.color} strokeWidth={1.25} strokeDasharray="3 3" pointerEvents="none" />
            )
          })}

          {bars.map((b, k) => b.eaten != null && b.eaten > 0 && (
            <rect key={k} x={geo.sx(b.x) - geo.barW / 2} y={geo.sb(b.eaten)} width={geo.barW}
              height={Math.max(0, geo.barTop + BAR_H - geo.sb(b.eaten))} rx={1.5}
              fill="var(--color-neg)" fillOpacity={hover != null && hover >= b.from && hover <= b.to ? 1 : b.actual ? 0.8 : 0.35} />
          ))}

          {geo.xl.map((i) => (
            <text key={i} x={geo.sx(days[i].x)} y={HEIGHT - 6}
              textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
              className="num fill-ink-3 text-[11px]">{label(days[i].date)}</text>
          ))}

          {hover != null && (
            <g pointerEvents="none">
              <line x1={geo.sx(days[hover].x)} x2={geo.sx(days[hover].x)} y1={PAD.top} y2={geo.barTop + BAR_H} stroke="var(--color-line-strong)" />
              <circle cx={geo.sx(days[hover].x)} cy={geo.sy(days[hover].extrinsic)} r={4} fill="var(--color-ink)" stroke="var(--color-bg)" strokeWidth={2} />
            </g>
          )}
          <rect x={PAD.left} y={0} width={Math.max(0, width - PAD.left - PAD.right)} height={HEIGHT}
            fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {geo && h && (
        <div className="pointer-events-none absolute top-0 z-10 min-w-44 rounded-[var(--radius-sm)] border border-line-strong bg-surface-3/95 px-3 py-2 text-xs shadow-[0_8px_24px_rgb(0_0_0/0.4)] backdrop-blur"
          style={{ left: geo.sx(h.x) + 12 > width - 200 ? geo.sx(h.x) - 202 : geo.sx(h.x) + 12 }}>
          <div className="text-ink">{label(h.date)} <span className="text-ink-3">{h.actual ? (hourly ? 'reading' : 'close') : 'projected'}</span></div>
          <dl className="num mt-1.5 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
            <dt className="text-ink-3">Extrinsic</dt><dd className="text-right text-ink">{money(h.extrinsic, 2)}</dd>
            <dt className="text-ink-3">Theta</dt><dd className="text-right text-neg">{h.eaten == null ? '-' : `${money(-h.eaten, 2)}/${per}`}</dd>
            {h.close && <>
              <dt className="text-ink-3">Underlying</dt><dd className="text-right text-ink-2">{num(h.close.underlying)}</dd>
              <dt className="text-ink-3">Option</dt><dd className="text-right text-ink-2">{num(h.close.option)}</dd>
              <dt className="text-ink-3">IV</dt><dd className="text-right text-ink-2">{vol(h.close.iv)}</dd>
            </>}
            {prevActual && <>
              <dt className="text-ink-3">Extrinsic change</dt>
              <dd className="text-right text-ink-2">{money(h.extrinsic - prevActual.extrinsic, 2)}</dd>
            </>}
          </dl>
          {prevActual && <p className="mt-1.5 max-w-44 text-[11px] text-ink-3">Change since the previous {hourly ? 'reading' : 'close'} includes moves in price and IV, not only theta.</p>}
        </div>
      )}
    </div>
  )
}
