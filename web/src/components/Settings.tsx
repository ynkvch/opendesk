import { GearSix } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** gear button with a pop-up of settings, opening down and to the left; closes on escape or a click outside it. */
export function Settings({ label = 'Chart settings', children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key) }
  }, [open])
  return (
    <div ref={box} className="relative inline-flex">
      <button type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] border transition-colors duration-150 active:translate-y-px ${
          open ? 'border-line-strong bg-surface-3 text-ink' : 'border-line bg-bg text-ink-3 hover:text-ink-2'}`}>
        <GearSix size={16} />
      </button>
      {open && (
        <div role="dialog" aria-label={label}
          className="absolute right-0 top-10 z-20 flex w-max max-w-[90vw] flex-col gap-3 rounded-[var(--radius-md)] border border-line-strong bg-surface-2 p-3 shadow-xl">
          {children}
        </div>
      )}
    </div>
  )
}

/** one labelled setting inside the pop-up, as wide as its own control. */
export function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="text-[11px] text-ink-3">{label}</span>
      {children}
    </div>
  )
}
