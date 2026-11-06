import { useMemo, useState, type ReactNode } from 'react'
import { linear, niceTicks, useWidth } from './util'

type Props = {
  values: number[]
  height?: number
  yFormat: (v: number) => string
  xLabel: (i: number) => string
  tooltip: (i: number) => ReactNode
  ariaLabel: string
}

const PAD = { top: 8, right: 8, bottom: 22, left: 52 }

/** Vertical bars around a zero baseline, green up / red down. */
export function Bars({ values, height = 160, yFormat, xLabel, tooltip, ariaLabel }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const geo = useMemo(() => {
    if (!width || !values.length) return null
    const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 3)
    const sy = linear(ticks[0], ticks[ticks.length - 1], height - PAD.bottom, PAD.top)
    const slot = (width - PAD.left - PAD.right) / values.length
    const bw = Math.max(1, slot - 2) // 2px surface gap between bars
    const xl = [0, Math.floor(values.length / 2), values.length - 1]
    return { ticks, sy, slot, bw, xl }
  }, [width, values, height])

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {geo && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
          {geo.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={geo.sy(t)} y2={geo.sy(t)}
                stroke={t === 0 ? 'var(--color-line-strong)' : 'var(--color-line)'} />
              <text x={PAD.left - 10} y={geo.sy(t)} dy="0.32em" textAnchor="end"
                className="num fill-ink-3 text-[11px]">{yFormat(t)}</text>
            </g>
          ))}
          {values.map((v, i) => {
            if (v === 0) return null
            const x = PAD.left + i * geo.slot + 1
            const y = geo.sy(Math.max(v, 0))
            const h = Math.max(1, Math.abs(geo.sy(v) - geo.sy(0)))
            return (
              <rect key={i} x={x} y={y} width={geo.bw} height={h} rx={Math.min(2, geo.bw / 2)}
                fill={v > 0 ? 'var(--color-pos)' : 'var(--color-neg)'}
                opacity={hover == null || hover === i ? 0.9 : 0.35} />
            )
          })}
          {geo.xl.map((i, k) => (
            <text key={i} x={PAD.left + i * geo.slot + geo.slot / 2} y={height - 5}
              textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}
              className="num fill-ink-3 text-[11px]">{xLabel(i)}</text>
          ))}
          {values.map((_, i) => (
            <rect key={`hit-${i}`} x={PAD.left + i * geo.slot} y={0} width={geo.slot} height={height - PAD.bottom}
              fill="transparent" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} />
          ))}
        </svg>
      )}
      {geo && hover != null && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-32 rounded-[var(--radius-sm)] border border-line-strong bg-surface-3/95 px-3 py-2 text-xs shadow-[0_8px_24px_rgb(0_0_0/0.4)] backdrop-blur"
          style={{ left: Math.min(PAD.left + hover * geo.slot + geo.slot + 8, width - 150) }}
        >
          {tooltip(hover)}
        </div>
      )}
    </div>
  )
}
