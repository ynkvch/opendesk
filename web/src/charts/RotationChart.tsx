import { useMemo } from 'react'
import type { Quadrant, RrgRow } from '../lib/rrg'
import { linear, niceTicks, useWidth } from './util'

export type Role = 'favoured' | 'avoid' | null

export const QUADRANT_COLOR: Record<Quadrant, string> = {
  leading: '#4fbf82', weakening: '#d9a441', lagging: '#e5645c', improving: '#6fa8e6',
}
export const QUADRANT_LABEL: Record<Quadrant, string> = {
  leading: 'Leading', weakening: 'Weakening', lagging: 'Lagging', improving: 'Improving',
}

type Props = {
  rows: RrgRow[]
  roles: Record<string, Role>
  bench: string
  hovered: string | null
  onHover: (symbol: string | null) => void
  ariaLabel: string
}

const H = 540
const PAD = { top: 20, right: 28, bottom: 52, left: 64 }
const DOT = 5.5
const RING = 10
const MINUS = '−'

type Box = { x: number; y: number; w: number; h: number }
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Sectors as dots on RS-Ratio × RS-Momentum; the hovered one shows its weekly path. Regime roles are rings around the dots. */
export function RotationChart({ rows, roles, bench, hovered, onHover, ariaLabel }: Props) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const iw = Math.max(0, w - PAD.left - PAD.right)
  const ih = H - PAD.top - PAD.bottom

  // symmetric around 100 on each axis, so the quadrant lines sit in the middle
  const { sx, sy, xt, yt } = useMemo(() => {
    const pts = rows.flatMap((r) => r.trail)
    const span = (k: 'ratio' | 'mom') => Math.max(1.5, ...pts.map((p) => Math.abs(p[k] - 100))) * 1.12
    const dx = span('ratio'), dy = span('mom')
    return {
      sx: linear(100 - dx, 100 + dx, PAD.left, PAD.left + iw),
      sy: linear(100 - dy, 100 + dy, PAD.top + ih, PAD.top),
      xt: niceTicks(100 - dx, 100 + dx, 6).filter((v) => Math.abs(v - 100) <= dx),
      yt: niceTicks(100 - dy, 100 + dy, 6).filter((v) => Math.abs(v - 100) <= dy),
    }
  }, [rows, iw, ih])

  // labels go right of the dot unless that hits another label or dot; then left, above, below
  const labels = useMemo(() => {
    const dots: Box[] = rows.map((r) => {
      const p = r.trail[r.trail.length - 1]
      return { x: sx(p.ratio) - RING, y: sy(p.mom) - RING, w: RING * 2, h: RING * 2 }
    })
    const placed: Box[] = []
    return rows.map((r, i) => {
      const p = r.trail[r.trail.length - 1]
      const cx = sx(p.ratio), cy = sy(p.mom)
      const lw = r.symbol.length * 7.6 + 40, lh = 14
      const tries: Box[] = [
        { x: cx + RING + 3, y: cy - lh / 2, w: lw, h: lh },
        { x: cx - RING - 3 - lw, y: cy - lh / 2, w: lw, h: lh },
        { x: cx - lw / 2, y: cy - RING - 2 - lh, w: lw, h: lh },
        { x: cx - lw / 2, y: cy + RING + 2, w: lw, h: lh },
      ]
      const ok = (b: Box) => !placed.some((o) => overlaps(o, b)) && !dots.some((d, j) => j !== i && overlaps(d, b))
        && b.x >= PAD.left && b.x + b.w <= PAD.left + iw
      const box = tries.find(ok) ?? tries[0]
      placed.push(box)
      return box
    })
  }, [rows, sx, sy, iw])

  const cx = sx(100), cy = sy(100)
  const hot = hovered ? rows.find((r) => r.symbol === hovered) : null

  return (
    <div ref={ref} className="relative w-full" style={{ height: H }} onMouseLeave={() => onHover(null)}>
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={ariaLabel} className="block select-none">
          {xt.map((v) => (
            <g key={`x${v}`}>
              <text x={sx(v)} y={PAD.top + ih + 20} textAnchor="middle" className="num fill-ink-3 font-mono text-[12px]">{v}</text>
            </g>
          ))}
          {yt.map((v) => (
            <g key={`y${v}`}>
              <text x={PAD.left - 12} y={sy(v) + 4} textAnchor="end" className="num fill-ink-3 font-mono text-[12px]">{v}</text>
            </g>
          ))}
          <line x1={cx} x2={cx} y1={PAD.top} y2={PAD.top + ih} stroke="var(--color-ink-3)" strokeWidth={1} />
          <line x1={PAD.left} x2={PAD.left + iw} y1={cy} y2={cy} stroke="var(--color-ink-3)" strokeWidth={1} />
          <text x={PAD.left + iw / 2} y={H - 10} textAnchor="middle" className="fill-ink-2 text-[11px] uppercase tracking-[0.12em]">
            RS-Ratio · right of 100 = outperforming {bench}
          </text>
          <text transform={`translate(16 ${PAD.top + ih / 2}) rotate(-90)`} textAnchor="middle"
            className="fill-ink-2 text-[11px] uppercase tracking-[0.12em]">
            RS-Momentum · above 100 = lead growing
          </text>

          {rows.map((r) => {
            const end = r.trail[r.trail.length - 1]
            const color = QUADRANT_COLOR[r.quadrant]
            const dim = hovered && hovered !== r.symbol
            const d = r.trail.map((p, i) => `${i ? 'L' : 'M'}${sx(p.ratio).toFixed(1)},${sy(p.mom).toFixed(1)}`).join('')
            return (
              <g key={`t${r.symbol}`} opacity={dim ? 0.15 : 1} className="transition-opacity duration-150">
                {hovered === r.symbol && (
                  <>
                    <path d={d} fill="none" stroke={color} strokeWidth={2} strokeOpacity={0.9} strokeLinejoin="round" strokeLinecap="round" />
                    {r.trail.slice(0, -1).map((p, k) => (
                      <circle key={p.date} cx={sx(p.ratio)} cy={sy(p.mom)} r={k ? 2.5 : 3.5} fill={color} opacity={0.8} />
                    ))}
                  </>
                )}
                <circle cx={sx(end.ratio)} cy={sy(end.mom)} r={DOT} fill={color} stroke="var(--color-surface)" strokeWidth={2} />
              </g>
            )
          })}
          {rows.map((r, i) => {
            const end = r.trail[r.trail.length - 1]
            const role = roles[r.symbol]
            const dim = hovered && hovered !== r.symbol
            const b = labels[i]
            return (
              <g key={`l${r.symbol}`} opacity={dim ? 0.2 : 1} className="cursor-default transition-opacity duration-150"
                onMouseEnter={() => onHover(r.symbol)}>
                {role && (
                  <circle cx={sx(end.ratio)} cy={sy(end.mom)} r={RING} fill="none" stroke="var(--color-ink)"
                    strokeWidth={1.5} strokeDasharray={role === 'avoid' ? '2.5 2.5' : undefined} />
                )}
                <circle cx={sx(end.ratio)} cy={sy(end.mom)} r={RING + 4} fill="transparent" />
                <text x={b.x} y={b.y + 11} className="text-[12px]">
                  <tspan className="fill-ink font-medium">{r.symbol}</tspan>
                  <tspan className="num fill-ink-3" dx={5}>β{r.beta < 0 ? MINUS : ''}{Math.abs(r.beta).toFixed(2)}</tspan>
                </text>
              </g>
            )
          })}
        </svg>
      )}
      {hot && (() => {
        const end = hot.trail[hot.trail.length - 1]
        const x = sx(end.ratio), y = sy(end.mom)
        const left = x > PAD.left + iw / 2
        return (
          <div className="pointer-events-none absolute z-10 w-[190px] rounded-[var(--radius-md)] border border-line-strong bg-surface-2 p-2.5 text-[12px] leading-relaxed text-ink-2 shadow-xl"
            style={{ left: left ? x - 190 - 16 : x + 16, top: Math.min(Math.max(y - 40, 0), H - 120) }}>
            <div className="flex items-baseline justify-between">
              <span className="font-medium text-ink">{hot.symbol}</span>
              <span style={{ color: QUADRANT_COLOR[hot.quadrant] }}>{QUADRANT_LABEL[hot.quadrant]}</span>
            </div>
            <div className="num mt-1">RS-Ratio {end.ratio.toFixed(1)} · Mom {end.mom.toFixed(1)}</div>
            <div className="num">β {hot.beta.toFixed(2)} vs {bench}</div>
            <div className="mt-1 text-[11px] text-ink-3">Trail: {hot.trail.length - 1} weeks to {end.date}</div>
          </div>
        )
      })()}
    </div>
  )
}
