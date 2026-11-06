import type { ReactNode } from 'react'

export function Segmented<T extends string>({
  value, options, onChange, label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label}
      className="inline-flex rounded-[var(--radius-md)] border border-line bg-bg p-0.5">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={`h-7 rounded-[var(--radius-sm)] px-2.5 text-xs font-medium transition-colors duration-150 active:translate-y-px ${
              on ? 'bg-surface-3 text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)]' : 'text-ink-3 hover:text-ink-2'
            }`}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Small section heading. Sentence case, no tracking games. */
export function Heading({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-4">
      <h2 className="text-[13px] font-medium text-ink-2">{children}</h2>
      {right}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-[var(--radius-sm)] bg-surface-2 ${className}`} />
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[var(--radius-md)] border border-neg/30 bg-neg-soft px-4 py-3 text-sm">
      <span className="text-ink">Could not load data: <span className="text-ink-2">{message}</span></span>
      {onRetry && (
        <button type="button" onClick={onRetry}
          className="h-7 rounded-[var(--radius-sm)] border border-line-strong px-3 text-xs font-medium hover:bg-surface-3">
          Retry
        </button>
      )}
    </div>
  )
}

export function Stat({ label, value, sub, valueClass = 'text-ink' }: {
  label: string
  value: ReactNode
  sub?: ReactNode
  valueClass?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-[13px] text-ink-3">{label}</dt>
      <dd className="text-right">
        <span className={`num text-[14px] ${valueClass}`}>{value}</span>
        {sub && <span className="num ml-2 text-xs text-ink-3">{sub}</span>}
      </dd>
    </div>
  )
}
