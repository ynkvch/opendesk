import { useId, useMemo, useState, type ReactNode } from 'react'
import { linear, niceTicks, useWidth } from './util'

type Props = {
  /** Cumulative return of the account, as a fraction (0.05 = +5%). */
  main: number[]
  /** Cumulative return of the benchmark over the same days. */
  bench: (number | null)[]
  height?: number
  xLabel: (i: number) => string
  yFormat: (v: number) => string
  tooltip: (i: number) => ReactNode
  ariaLabel: string
  /** Keep 0 in view (returns). Off for dollar values, which would flatten the line. */
  includeZero?: boolean
}

const PAD = { top: 12, right: 12, bottom: 24, left: 52 }

/** Account vs benchmark on one percentage axis: solid line with fill, benchmark dotted. */
export function CompareChart({ main, bench, height = 260, xLabel, yFormat, tooltip, ariaLabel, includeZero = true }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const uid = useId().replace(/:/g, '')

  const geo = useMemo(() => {
    if (!width || main.length < 2) return null
    const vals = [...main, ...bench.filter((v): v is number => v != null), ...(includeZero ? [0] : [])]
    const ticks = niceTicks(Math.min(...vals), Math.max(...vals), 4)
    const sx = linear(0, main.length - 1, PAD.left, width - PAD.right)
    const sy = linear(ticks[0], ticks[ticks.length - 1], height - PAD.bottom, PAD.top)
    const px = main.map((_, i) => sx(i))
    const path = (vs: (number | null)[]) => {
      let d = ''
      let pen = false
      vs.forEach((v, i) => {
        if (v == null) { pen = false; return }
        d += `${pen ? 'L' : 'M'}${px[i].toFixed(1)},${sy(v).toFixed(1)}`
        pen = true
      })
      return d
    }
    const mainD = path(main)
    const base = height - PAD.bottom
    const area = `${mainD}L${px[px.length - 1].toFixed(1)},${base}L${px[0].toFixed(1)},${base}Z`
    const nl = Math.max(2, Math.min(5, main.length, Math.floor((width - PAD.left) / 90)))
    const xl = Array.from({ length: nl }, (_, k) => Math.round((k * (main.length - 1)) / (nl - 1)))
    return { ticks, sy, px, mainD, benchD: path(bench), area, xl }
  }, [width, main, bench, height, includeZero])

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    if (!geo) return
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left + PAD.left
    const step = (geo.px[geo.px.length - 1] - geo.px[0]) / (geo.px.length - 1)
    setHover(Math.min(geo.px.length - 1, Math.max(0, Math.round((x - PAD.left) / step))))
  }

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {geo && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
          <defs>
            <linearGradient id={`cmp-${uid}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--color-ink)" stopOpacity="0.11" />
              <stop offset="100%" stopColor="var(--color-ink)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {geo.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={geo.sy(t)} y2={geo.sy(t)}
                stroke={t === 0 && includeZero ? 'var(--color-line-strong)' : 'var(--color-line)'} />
              <text x={PAD.left - 10} y={geo.sy(t)} dy="0.32em" textAnchor="end"
                className="num fill-ink-3 text-[11px]">{yFormat(t)}</text>
            </g>
          ))}
          {geo.xl.map((i, k) => (
            <text key={i} x={geo.px[i]} y={height - 6}
              textAnchor={k === 0 ? 'start' : k === geo.xl.length - 1 ? 'end' : 'middle'}
              className="num fill-ink-3 text-[11px]">{xLabel(i)}</text>
          ))}
          <path d={geo.area} fill={`url(#cmp-${uid})`} />
          <path d={geo.benchD} fill="none" stroke="var(--color-ink-3)" strokeWidth={1.5}
            strokeDasharray="1.5 3.5" strokeLinecap="round" />
          <path d={geo.mainD} fill="none" stroke="var(--color-ink)" strokeWidth={1.75}
            strokeLinejoin="round" strokeLinecap="round" />
          {hover != null && (
            <g pointerEvents="none">
              <line x1={geo.px[hover]} x2={geo.px[hover]} y1={PAD.top} y2={height - PAD.bottom}
                stroke="var(--color-line-strong)" />
              {bench[hover] != null && (
                <circle cx={geo.px[hover]} cy={geo.sy(bench[hover]!)} r={3.5} fill="var(--color-ink-3)"
                  stroke="var(--color-bg)" strokeWidth={2} />
              )}
              <circle cx={geo.px[hover]} cy={geo.sy(main[hover])} r={4} fill="var(--color-ink)"
                stroke="var(--color-bg)" strokeWidth={2} />
            </g>
          )}
          <rect x={PAD.left} y={0} width={Math.max(0, width - PAD.left - PAD.right)} height={height}
            fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {geo && hover != null && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-44 rounded-[var(--radius-sm)] border border-line-strong bg-surface-3/95 px-3 py-2 text-xs shadow-[0_8px_24px_rgb(0_0_0/0.4)] backdrop-blur"
          style={{ left: geo.px[hover] + 12 > width - 200 ? geo.px[hover] - 202 : geo.px[hover] + 12 }}
        >
          {tooltip(hover)}
        </div>
      )}
    </div>
  )
}
