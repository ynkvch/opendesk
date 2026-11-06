import { useId, useMemo, useState } from 'react'
import { breakevens, pnlAt, pnlAtExpiry, type Position } from '../lib/payoff'
import { num, signedMoney, tone } from '../lib/format'
import { linear, niceTicks, useWidth } from './util'

type Props = {
  position: Position
  /** Time (ms) for the second curve: now for open trades, the exit for closed ones. */
  at: number
  atLabel: string
  /** Legs' IV to use at `at`; the expiry curve doesn't need IV. */
  atPosition: Position
  entrySpot: number
  /** Where the underlying is now / was at exit, and the P&L there. */
  mark: { spot: number; pnl: number; label: string } | null
  /** Price levels that should stay in view (strikes are always included). */
  include: number[]
  /** Shares: one line, since value at expiry and now are the same thing. */
  single?: boolean
  height?: number
}

const PAD = { top: 28, right: 16, bottom: 28, left: 60 }
const N = 220

export function PayoffChart({ position, at, atLabel, atPosition, entrySpot, mark, include, single = false, height = 320 }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const uid = useId().replace(/:/g, '')

  const geo = useMemo(() => {
    if (!width) return null
    const strikes = position.legs.map((l) => (l.right === 'S' ? position.entry : l.strike))
    const pts = [...strikes, ...include, entrySpot]
    const lo0 = Math.min(...pts)
    const hi0 = Math.max(...pts)
    const pad = Math.max((hi0 - lo0) * 0.35, entrySpot * 0.03)
    const lo = Math.max(0.01, lo0 - pad)
    const hi = hi0 + pad
    const xs = Array.from({ length: N }, (_, i) => lo + ((hi - lo) * i) / (N - 1))
    const exp = xs.map((s) => pnlAtExpiry(position, s))
    const now = xs.map((s) => pnlAt(atPosition, s, at))
    const ys = [...exp, ...now, 0, ...(mark ? [mark.pnl] : [])]
    const ticks = niceTicks(Math.min(...ys), Math.max(...ys), 5)
    const sx = linear(lo, hi, PAD.left, width - PAD.right)
    const sy = linear(ticks[0], ticks[ticks.length - 1], height - PAD.bottom, PAD.top)
    const d = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${sx(xs[i]).toFixed(1)},${sy(v).toFixed(1)}`).join('')
    const expD = d(exp)
    const zeroY = sy(0)
    const area = `${expD}L${sx(hi).toFixed(1)},${zeroY}L${sx(lo).toFixed(1)},${zeroY}Z`
    const xt = niceTicks(lo, hi, Math.max(3, Math.min(7, Math.floor(width / 110)))).filter((v) => v >= lo && v <= hi)
    return { lo, hi, xs, exp, now, ticks, sx, sy, expD, nowD: d(now), area, zeroY, xt, be: breakevens(position, lo, hi) }
  }, [width, height, position, atPosition, at, entrySpot, include, mark])

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    if (!geo) return
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left
    const frac = x / (width - PAD.left - PAD.right)
    setHover(Math.min(N - 1, Math.max(0, Math.round(frac * (N - 1)))))
  }

  const vline = (x: number, label: string, strong: boolean, key: string, anchor: 'start' | 'middle' | 'end') => (
    <g key={key}>
      <line x1={x} x2={x} y1={PAD.top - 6} y2={height - PAD.bottom}
        stroke={strong ? 'var(--color-ink-2)' : 'var(--color-ink-3)'} strokeDasharray={strong ? undefined : '2 3'} />
      <text x={x + (anchor === 'start' ? 4 : anchor === 'end' ? -4 : 0)} y={PAD.top - 12} textAnchor={anchor}
        className="fill-ink-2 text-[11px]">{label}</text>
    </g>
  )
  // push the two labels apart when the entry and mark lines sit close together
  const ex = geo ? geo.sx(entrySpot) : 0
  const mx = geo && mark ? geo.sx(mark.spot) : 0
  const close = !!mark && Math.abs(ex - mx) < 48
  const entryAnchor = close ? (ex <= mx ? 'end' : 'start') : 'middle'
  const markAnchor = close ? (ex <= mx ? 'start' : 'end') : 'middle'

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }}>
      {geo && (
        <svg width={width} height={height} role="img" className="block"
          aria-label={`Payoff diagram: profit and loss at expiry and ${atLabel.toLowerCase()} across underlying prices`}>
          <defs>
            <clipPath id={`up-${uid}`}><rect x="0" y="0" width={width} height={Math.max(0, geo.zeroY)} /></clipPath>
            <clipPath id={`dn-${uid}`}><rect x="0" y={geo.zeroY} width={width} height={Math.max(0, height - geo.zeroY)} /></clipPath>
          </defs>

          {geo.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={geo.sy(t)} y2={geo.sy(t)}
                stroke={t === 0 ? 'var(--color-line-strong)' : 'var(--color-line)'} />
              <text x={PAD.left - 10} y={geo.sy(t)} dy="0.32em" textAnchor="end"
                className="num fill-ink-3 text-[11px]">{signedMoney(t)}</text>
            </g>
          ))}
          {geo.xt.map((v) => (
            <text key={v} x={geo.sx(v)} y={height - 8} textAnchor="middle" className="num fill-ink-3 text-[11px]">{num(v, v % 1 ? 1 : 0)}</text>
          ))}

          <path d={geo.area} fill="var(--color-pos-soft)" clipPath={`url(#up-${uid})`} />
          <path d={geo.area} fill="var(--color-neg-soft)" clipPath={`url(#dn-${uid})`} />

          {vline(ex, 'Entry', false, 'entry', entryAnchor)}
          {mark && vline(mx, mark.label, true, 'mark', markAnchor)}

          {!single && <path d={geo.nowD} fill="none" stroke="var(--color-ink-2)" strokeWidth={1.5} strokeDasharray="4 3" />}
          <path d={geo.expD} fill="none" stroke="var(--color-ink)" strokeWidth={1.75} strokeLinejoin="round" />

          {geo.be.map((b) => (
            <g key={b}>
              <circle cx={geo.sx(b)} cy={geo.zeroY} r={3.5} fill="var(--color-bg)" stroke="var(--color-ink)" strokeWidth={1.5} />
              <text x={geo.sx(b)} y={geo.zeroY + 16} textAnchor="middle" className="num fill-ink-3 text-[11px]">{num(b)}</text>
            </g>
          ))}
          {mark && (
            <circle cx={geo.sx(mark.spot)} cy={geo.sy(mark.pnl)} r={5} fill={mark.pnl >= 0 ? 'var(--color-pos)' : 'var(--color-neg)'}
              stroke="var(--color-bg)" strokeWidth={2} />
          )}

          {hover != null && (
            <g pointerEvents="none">
              <line x1={geo.sx(geo.xs[hover])} x2={geo.sx(geo.xs[hover])} y1={PAD.top} y2={height - PAD.bottom} stroke="var(--color-line-strong)" />
              <circle cx={geo.sx(geo.xs[hover])} cy={geo.sy(geo.exp[hover])} r={3.5} fill="var(--color-ink)" stroke="var(--color-bg)" strokeWidth={2} />
              {!single && <circle cx={geo.sx(geo.xs[hover])} cy={geo.sy(geo.now[hover])} r={3.5} fill="var(--color-ink-2)" stroke="var(--color-bg)" strokeWidth={2} />}
            </g>
          )}
          <rect x={PAD.left} y={0} width={Math.max(0, width - PAD.left - PAD.right)} height={height}
            fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {geo && hover != null && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-44 rounded-[var(--radius-sm)] border border-line-strong bg-surface-3/95 px-3 py-2 text-xs shadow-[0_8px_24px_rgb(0_0_0/0.4)] backdrop-blur"
          style={{ left: geo.sx(geo.xs[hover]) + 12 > width - 200 ? geo.sx(geo.xs[hover]) - 202 : geo.sx(geo.xs[hover]) + 12 }}
        >
          <div className="text-ink-3">Underlying at <span className="num text-ink-2">{num(geo.xs[hover])}</span></div>
          <div className="mt-1.5 flex justify-between gap-4">
            <span className="text-ink-2">{single ? 'P&L' : 'At expiry'}</span>
            <span className={`num ${tone(geo.exp[hover])}`}>{signedMoney(geo.exp[hover])}</span>
          </div>
          {!single && (
            <div className="flex justify-between gap-4">
              <span className="text-ink-2">{atLabel}</span>
              <span className={`num ${tone(geo.now[hover])}`}>{signedMoney(geo.now[hover])}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
