import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { linear, niceTicks } from './util'

export type Line = { label: string; axis: 'left' | 'right'; points: [string, number][] }
export type Level = { value: number; label: string }

/** One line: blue. Two lines: the main one pale blue, the second a deeper blue. */
const SINGLE = '#4d94ff'
const PAIR = ['#bfd8ff', '#518eed']
export const lineColor = (i: number, count: number, pale = false) => (count > 1 ? PAIR[i % PAIR.length] : pale ? PAIR[0] : SINGLE)

type Props = {
  lines: Line[]
  levels: Level[]
  format: (v: number) => string
  /** Formats the right axis when a line sits on it (different scale). */
  formatRight?: (v: number) => string
  /** Shade the gap between the first two lines (same axis): blue where the second is above, red where it is below. */
  fillGap?: boolean
  /** Tooltip name and format for the second line minus the first, when the gap is filled. */
  gapLabel?: string
  formatGap?: (v: number) => string
  /** Draw a single line in the pale blue instead of the bright one. */
  pale?: boolean
  ariaLabel: string
}

const PAD = { top: 16, right: 16, bottom: 28, left: 64 }

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

const DAY = 86_400_000
const t = (d: string) => Date.parse(d + 'T00:00:00Z')
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')
const xLabel = (ms: number, spanDays: number) => {
  const d = new Date(ms)
  return spanDays > 400 ? `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`
    : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

/**
 * Polygons between two lines, matched by date, split where they cross so each piece has one sign.
 * `inverted` = the first line (short rate) is above the second (long rate).
 */
function gapAreas(a: [string, number][], b: [string, number][], sx: (v: number) => number, sy: (v: number) => number) {
  const other = new Map(b)
  const pts = a.flatMap(([d, v]) => (other.has(d) ? [{ x: sx(t(d)), lo: v, hi: other.get(d)! }] : []))
  const out: { d: string; inverted: boolean }[] = []
  let run: { x: number; lo: number; hi: number }[] = []
  const flush = () => {
    if (run.length > 1) {
      const top = run.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${sy(p.hi).toFixed(1)}`).join('')
      const bottom = [...run].reverse().map((p) => `L${p.x.toFixed(1)},${sy(p.lo).toFixed(1)}`).join('')
      out.push({ d: `${top}${bottom}Z`, inverted: run.some((p) => p.lo > p.hi) })
    }
  }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const prev = pts[i - 1]
    if (prev && (prev.hi - prev.lo) * (p.hi - p.lo) < 0) {
      // the lines cross between prev and p: end this piece and start the next at the crossing
      const f = (prev.hi - prev.lo) / ((prev.hi - prev.lo) - (p.hi - p.lo))
      const cross = { x: prev.x + (p.x - prev.x) * f, lo: prev.lo + (p.lo - prev.lo) * f, hi: prev.lo + (p.lo - prev.lo) * f }
      run.push(cross)
      flush()
      run = [cross]
    }
    run.push(p)
  }
  flush()
  return out
}

/** Large time-series chart: no grid, blue lines, dashed rule levels, crosshair tooltip. Fills its container. */
export function RegimeChart({ lines, levels, format, formatRight, fillGap = false, gapLabel = 'Spread', formatGap, pale = false, ariaLabel }: Props) {
  const [ref, { w, h }] = useSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const hasRight = lines.some((l) => l.axis === 'right' && l.points.length)
  const pad = { ...PAD, right: hasRight ? 64 : PAD.right }

  const geo = useMemo(() => {
    const all = lines.flatMap((l) => l.points)
    if (!w || !h || all.length < 2) return null
    const x0 = Math.min(...all.map((p) => t(p[0])))
    const x1 = Math.max(...all.map((p) => t(p[0])))
    const sx = linear(x0, x1, pad.left, w - pad.right)
    const scale = (axis: 'left' | 'right') => {
      const ys = lines.filter((l) => l.axis === axis).flatMap((l) => l.points.map((p) => p[1]))
      if (!ys.length) return null
      if (axis === 'left') ys.push(...levels.map((l) => l.value))
      let lo = Math.min(...ys)
      let hi = Math.max(...ys)
      const m = (hi - lo) * 0.06 || 1
      lo -= m
      hi += m
      const ticks = niceTicks(lo, hi, Math.max(3, Math.round(h / 90))).filter((v) => v >= lo && v <= hi)
      return { sy: linear(lo, hi, h - pad.bottom, pad.top), ticks }
    }
    const left = scale('left')
    const right = scale('right')
    const paths = lines.map((l) => {
      const s = (l.axis === 'right' ? right : left)!
      return l.points.map((p, i) => `${i ? 'L' : 'M'}${sx(t(p[0])).toFixed(1)},${s.sy(p[1]).toFixed(1)}`).join('')
    })
    const span = (x1 - x0) / DAY
    const n = Math.max(2, Math.round(w / 180))
    const xticks = Array.from({ length: n }, (_, i) => x0 + ((x1 - x0) * i) / (n - 1))
    const gaps = fillGap && left && lines.length > 1 ? gapAreas(lines[0].points, lines[1].points, sx, left.sy) : []
    return { sx, left, right, paths, gaps, span, xticks, x0, x1 }
  }, [lines, levels, fillGap, w, h, pad.left, pad.right])

  // hover snaps to the nearest date of the first line
  const base = lines[0]?.points ?? []
  const nearest = (px: number) => {
    if (!geo || !base.length) return null
    const target = geo.x0 + ((px - pad.left) / (w - pad.left - pad.right)) * (geo.x1 - geo.x0)
    let lo = 0
    let hi = base.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (t(base[mid][0]) < target) lo = mid + 1
      else hi = mid
    }
    return lo > 0 && Math.abs(t(base[lo - 1][0]) - target) < Math.abs(t(base[lo][0]) - target) ? lo - 1 : lo
  }
  const at = hover != null ? base[hover] : null
  const valueOn = (l: Line, d: string) => {
    // last value on or before the hovered date (weekly and monthly lines have gaps)
    let v: number | null = null
    for (const p of l.points) {
      if (p[0] > d) break
      v = p[1]
    }
    return v
  }

  return (
    <div ref={ref} className="relative h-full w-full select-none">
      {geo && (
        <svg width={w} height={h} role="img" aria-label={ariaLabel} className="block"
          onMouseMove={(e) => setHover(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left))}
          onMouseLeave={() => setHover(null)}>
          {geo.left?.ticks.map((v) => (
            <text key={`l${v}`} x={pad.left - 10} y={geo.left!.sy(v)} dy="0.32em" textAnchor="end"
              className="num fill-ink-3 text-[11px]">{format(v)}</text>
          ))}
          {geo.right?.ticks.map((v) => (
            <text key={`r${v}`} x={w - pad.right + 10} y={geo.right!.sy(v)} dy="0.32em"
              className="num text-[11px]" fill={lineColor(1, 2)} opacity={0.8}>{(formatRight ?? format)(v)}</text>
          ))}
          {geo.xticks.map((x, i) => (
            <text key={x} x={geo.sx(x)} y={h - 8} textAnchor={i === 0 ? 'start' : i === geo.xticks.length - 1 ? 'end' : 'middle'}
              className="num fill-ink-3 text-[11px]">{xLabel(x, geo.span)}</text>
          ))}
          {geo.left && levels.map((l) => (
            <g key={l.label}>
              <line x1={pad.left} x2={w - pad.right} y1={geo.left!.sy(l.value)} y2={geo.left!.sy(l.value)}
                stroke="rgb(255 255 255 / 0.28)" strokeDasharray="4 5" />
              <text x={w - pad.right - 4} y={geo.left!.sy(l.value) - 6} textAnchor="end" className="fill-ink-3 text-[10px]">
                {l.label} {format(l.value)}
              </text>
            </g>
          ))}
          {geo.gaps.map((g, i) => (
            <path key={`gap${i}`} d={g.d} fill={g.inverted ? 'rgb(229 100 92 / 0.22)' : 'rgb(81 142 237 / 0.16)'} />
          ))}
          {geo.paths.map((d, i) => (
            <path key={lines[i].label} d={d} fill="none" stroke={lineColor(i, lines.length, pale)}
              strokeWidth={i === 0 ? 1.6 : 1.2} strokeLinejoin="round" opacity={i === 0 ? 1 : 0.85} />
          ))}
          {at && (
            <line x1={geo.sx(t(at[0]))} x2={geo.sx(t(at[0]))} y1={pad.top} y2={h - pad.bottom}
              stroke="rgb(255 255 255 / 0.25)" />
          )}
        </svg>
      )}
      {geo && at && (
        <div className="pointer-events-none absolute top-2 rounded-[var(--radius-sm)] border border-line-strong bg-surface-2/95 px-2.5 py-1.5 text-xs shadow-lg"
          style={geo.sx(t(at[0])) > w / 2 ? { right: w - geo.sx(t(at[0])) + 12 } : { left: geo.sx(t(at[0])) + 12 }}>
          <div className="text-ink-3">{at[0]}</div>
          {lines.map((l, i) => {
            const v = valueOn(l, at[0])
            return v == null ? null : (
              <div key={l.label} className="num mt-0.5 flex items-center gap-2 text-ink">
                <span className="h-0.5 w-3 rounded" style={{ background: lineColor(i, lines.length, pale) }} />
                {l.label} {l.axis === 'right' && formatRight ? formatRight(v) : format(v)}
              </div>
            )
          })}
          {fillGap && lines.length > 1 && (() => {
            const lo = valueOn(lines[0], at[0])
            const hi = valueOn(lines[1], at[0])
            return lo == null || hi == null ? null : (
              <div className={`num mt-1 border-t border-line pt-1 ${hi < lo ? 'text-neg' : 'text-ink'}`}>{gapLabel} {(formatGap ?? format)(hi - lo)}</div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
