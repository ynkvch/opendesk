/** Tiny trend line for a card. Scales to its container; no axes. */
export function Sparkline({ values, height = 36, label }: { values: number[]; height?: number; label: string }) {
  if (values.length < 2) return <div style={{ height }} />
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const W = 100
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, height - 3 - ((v - lo) / span) * (height - 6)])
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('')
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img"
      aria-label={label} className="block overflow-visible">
      <path d={`${d}L${W},${height}L0,${height}Z`} fill="var(--color-ink)" opacity="0.05" />
      <path d={d} fill="none" stroke="var(--color-ink-2)" strokeWidth="1.25" vectorEffect="non-scaling-stroke"
        strokeLinejoin="round" />
    </svg>
  )
}
