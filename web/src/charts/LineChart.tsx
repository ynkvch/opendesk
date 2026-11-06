import { useId, useMemo, useState, type ReactNode } from 'react'
import { linear, niceTicks, useWidth } from './util'

export type Point = { x: number; y: number }

type Marker = { index: number; label: string; tone: 'pos' | 'neg' | 'ink' }

type Props = {
  points: Point[]
  height?: number
  /** 'ink': single neutral line with soft fill. 'signed': fill green above zero, red below. */
  variant?: 'ink' | 'signed'
  yFormat: (v: number) => string
  xFormat: (v: number) => string
  tooltip: (i: number) => ReactNode
  markers?: Marker[]
  /** Evenly spaced by index instead of by x value (skips nights/weekends). */
  byIndex?: boolean
  /** How many x-axis labels to show. */
  xLabels?: number
  ariaLabel: string
}

const BASE_PAD = { top: 12, right: 12, bottom: 24, left: 56 }
// leave headroom for marker labels drawn above/below the line
const MARKER_PAD = { ...BASE_PAD, top: 26, bottom: 30 }

export function LineChart({
  points, height = 240, variant = 'ink', yFormat, xFormat, tooltip, markers = [], byIndex = false, xLabels = 5,
  ariaLabel,
}: Props) {
  const PAD = markers.length ? MARKER_PAD : BASE_PAD
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const uid = useId().replace(/:/g, '')

  const geo = useMemo(() => {
    if (!width || points.length < 2) return null
    const ys = points.map((p) => p.y)
    let lo = Math.min(...ys)
    let hi = Math.max(...ys)
    if (variant === 'signed') {
      lo = Math.min(lo, 0)
      hi = Math.max(hi, 0)
    }
    const ticks = niceTicks(lo, hi, 4)
    const y0 = ticks[0]
    const y1 = ticks[ticks.length - 1]
    const xs = byIndex ? points.map((_, i) => i) : points.map((p) => p.x)
    const sx = linear(xs[0], xs[xs.length - 1], PAD.left, width - PAD.right)
    const sy = linear(y0, y1, height - PAD.bottom, PAD.top)
    const px = xs.map(sx)
    const py = points.map((p) => sy(p.y))
    const line = px.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${py[i].toFixed(1)}`).join('')
    const zeroY = sy(variant === 'signed' ? 0 : y0)
    const area = `${line}L${px[px.length - 1].toFixed(1)},${zeroY.toFixed(1)}L${px[0].toFixed(1)},${zeroY.toFixed(1)}Z`
    const nl = Math.max(2, Math.min(xLabels, points.length, Math.floor((width - PAD.left) / 90)))
    const xl = Array.from({ length: nl }, (_, k) => Math.round((k * (points.length - 1)) / Math.max(1, nl - 1)))
    return { ticks, sy, px, py, line, area, zeroY, xl }
  }, [width, points, height, variant, byIndex, xLabels, PAD])

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    if (!geo) return
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left + PAD.left
    let best = 0
    for (let i = 1; i < geo.px.length; i++) if (Math.abs(geo.px[i] - x) < Math.abs(geo.px[best] - x)) best = i
    setHover(best)
  }

  const markerColor = { pos: 'var(--color-pos)', neg: 'var(--color-neg)', ink: 'var(--color-ink)' }

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {geo && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
          <defs>
            <linearGradient id={`fill-${uid}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--color-ink)" stopOpacity="0.10" />
              <stop offset="100%" stopColor="var(--color-ink)" stopOpacity="0" />
            </linearGradient>
            <clipPath id={`above-${uid}`}>
              <rect x="0" y="0" width={width} height={Math.max(0, geo.zeroY)} />
            </clipPath>
            <clipPath id={`below-${uid}`}>
              <rect x="0" y={geo.zeroY} width={width} height={Math.max(0, height - geo.zeroY)} />
            </clipPath>
          </defs>

          {geo.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={geo.sy(t)} y2={geo.sy(t)}
                stroke={variant === 'signed' && t === 0 ? 'var(--color-line-strong)' : 'var(--color-line)'} />
              <text x={PAD.left - 10} y={geo.sy(t)} dy="0.32em" textAnchor="end"
                className="num fill-ink-3 text-[11px]">{yFormat(t)}</text>
            </g>
          ))}
          {geo.xl.map((i) => (
            <text key={i} x={geo.px[i]} y={height - 6}
              textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
              className="num fill-ink-3 text-[11px]">{xFormat(points[i].x)}</text>
          ))}

          {variant === 'ink' ? (
            <path d={geo.area} fill={`url(#fill-${uid})`} />
          ) : (
            <>
              <path d={geo.area} fill="var(--color-pos-soft)" clipPath={`url(#above-${uid})`} />
              <path d={geo.area} fill="var(--color-neg-soft)" clipPath={`url(#below-${uid})`} />
            </>
          )}
          <path d={geo.line} fill="none" stroke={variant === 'ink' ? 'var(--color-ink)' : 'var(--color-ink-2)'}
            strokeWidth={variant === 'ink' ? 1.75 : 1.5} strokeLinejoin="round" strokeLinecap="round" />

          {markers.map((m) => (
            <g key={m.label}>
              <circle cx={geo.px[m.index]} cy={geo.py[m.index]} r={4.5} fill={markerColor[m.tone]}
                stroke="var(--color-surface)" strokeWidth={2} />
              <text x={geo.px[m.index]} y={geo.py[m.index] + (m.tone === 'neg' ? 18 : -10)}
                textAnchor={geo.px[m.index] > width - 80 ? 'end' : geo.px[m.index] < PAD.left + 40 ? 'start' : 'middle'}
                className="fill-ink-2 text-[11px] font-medium">{m.label}</text>
            </g>
          ))}

          {hover != null && (
            <g pointerEvents="none">
              <line x1={geo.px[hover]} x2={geo.px[hover]} y1={PAD.top} y2={height - PAD.bottom}
                stroke="var(--color-line-strong)" />
              <circle cx={geo.px[hover]} cy={geo.py[hover]} r={4} fill="var(--color-ink)"
                stroke="var(--color-bg)" strokeWidth={2} />
            </g>
          )}
          <rect x={PAD.left} y={0} width={Math.max(0, width - PAD.left - PAD.right)} height={height}
            fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {geo && hover != null && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-[var(--radius-sm)] border border-line-strong bg-surface-3/95 px-3 py-2 text-xs shadow-[0_8px_24px_rgb(0_0_0/0.4)] backdrop-blur"
          style={{ left: geo.px[hover] + 12 > width - 180 ? geo.px[hover] - 182 : geo.px[hover] + 12 }}
        >
          {tooltip(hover)}
        </div>
      )}
    </div>
  )
}
