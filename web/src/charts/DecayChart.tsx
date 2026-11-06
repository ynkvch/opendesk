import { useMemo, useState } from 'react'
import type { ThetaClose, ThetaDay } from '../lib/api'
import { date, money, num, vol } from '../lib/format'
import { linear, niceTicks, useWidth } from './util'

type Props = {
  history: ThetaClose[]
  projection: ThetaDay[]
  /** vertical reference lines; their meaning is explained outside the chart */
  markers?: { date: string; color: string }[]
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
export function DecayChart({ history, projection, markers = [], ariaLabel }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const days = useMemo<Day[]>(() => {
    const t0 = new Date(history[0]?.date ?? projection[0]?.date).getTime()
    const x = (d: string) => (new Date(d).getTime() - t0) / DAY_MS
    return [
      ...history.map((h) => ({ date: h.date, x: x(h.date), extrinsic: h.extrinsic, eaten: h.theta == null ? null : -h.theta, actual: true, close: h })),
      ...projection.map((p) => ({ date: p.date, x: x(p.date), extrinsic: p.extrinsic, eaten: p.decay, actual: false })),
    ]
  }, [history, projection])

  const geo = useMemo(() => {
    if (!width || days.length < 2) return null
    const xs = days.map((d) => d.x)
    const sx = linear(xs[0], xs[xs.length - 1], PAD.left, width - PAD.right)
    const ext = niceTicks(Math.min(0, ...days.map((d) => d.extrinsic)), Math.max(...days.map((d) => d.extrinsic)), 4)
    const sy = linear(ext[0], ext[ext.length - 1], PAD.top + TOP_H, PAD.top)
    const eaten = niceTicks(0, Math.max(...days.map((d) => d.eaten ?? 0)), 2)
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
    const step = days.length > 1 ? (sx(days[days.length - 1].x) - sx(days[0].x)) / (days[days.length - 1].x - days[0].x) : 10
    const barW = Math.max(2, Math.min(16, step * 0.6))
    const nl = Math.max(2, Math.min(6, Math.floor((width - PAD.left) / 90)))
    const xl = Array.from({ length: nl }, (_, k) => Math.round((k * (days.length - 1)) / (nl - 1)))
    return { sx, sy, sb, ext, eaten, barTop, past: path(past), future: split < days.length ? path(future) : '', area, barW, xl, split }
  }, [width, days, history.length])

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
          <text x={PAD.left} y={geo.barTop - 10} className="fill-ink-3 text-[11px]">Taken by theta per day</text>
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

          {days.map((d, i) => d.eaten != null && d.eaten > 0 && (
            <rect key={d.date} x={geo.sx(d.x) - geo.barW / 2} y={geo.sb(d.eaten)} width={geo.barW}
              height={Math.max(0, geo.barTop + BAR_H - geo.sb(d.eaten))} rx={1.5}
              fill="var(--color-neg)" fillOpacity={hover === i ? 1 : d.actual ? 0.8 : 0.35} />
          ))}

          {geo.xl.map((i) => (
            <text key={i} x={geo.sx(days[i].x)} y={HEIGHT - 6}
              textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
              className="num fill-ink-3 text-[11px]">{date(days[i].date)}</text>
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
          <div className="text-ink">{date(h.date)} <span className="text-ink-3">{h.actual ? 'close' : 'projected'}</span></div>
          <dl className="num mt-1.5 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
            <dt className="text-ink-3">Extrinsic</dt><dd className="text-right text-ink">{money(h.extrinsic, 2)}</dd>
            <dt className="text-ink-3">Theta</dt><dd className="text-right text-neg">{h.eaten == null ? '-' : `${money(-h.eaten, 2)}/day`}</dd>
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
          {prevActual && <p className="mt-1.5 max-w-44 text-[11px] text-ink-3">Change since the previous close includes moves in price and IV, not only theta.</p>}
        </div>
      )}
    </div>
  )
}
