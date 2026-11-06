/**
 * Compact excursion glyph in R units: a line from MAE to MFE, a tick at zero,
 * and a dot where the trade finished. Domain is fixed so rows compare.
 */
const LO = -1
const HI = 1.6

export function Excursion({ mae, mfe, pnl, risk, width = 96 }: {
  mae: number
  mfe: number
  pnl: number | null
  risk: number
  width?: number
}) {
  const x = (usd: number) => {
    const r = Math.min(HI, Math.max(LO, usd / risk))
    return 3 + ((r - LO) / (HI - LO)) * (width - 6)
  }
  const done = pnl ?? 0
  return (
    <svg width={width} height={14} aria-hidden className="block">
      <line x1={x(0)} x2={x(0)} y1={2} y2={12} stroke="var(--color-line-strong)" />
      <line x1={x(mae)} x2={x(0)} y1={7} y2={7} stroke="var(--color-neg)" strokeWidth={2} strokeLinecap="round" opacity={0.7} />
      <line x1={x(0)} x2={x(mfe)} y1={7} y2={7} stroke="var(--color-pos)" strokeWidth={2} strokeLinecap="round" opacity={0.7} />
      <circle cx={x(done)} cy={7} r={3.25} fill="var(--color-ink)" stroke="var(--color-bg)" strokeWidth={1.5} />
    </svg>
  )
}
