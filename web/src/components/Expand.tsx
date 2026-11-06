import { ArrowsOutSimple, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

/** A chart card that opens 1335 px wide over a dimmed page; Esc or a click outside closes it. */
export function useExpand() {
  const ref = useRef<HTMLElement>(null)
  const [full, setFull] = useState(false)
  // the card's height, kept as a placeholder so the grid doesn't reflow while it is open on top
  const [slot, setSlot] = useState(0)
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false) }
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflow
      window.removeEventListener('keydown', onKey)
    }
  }, [full])
  const toggle = () => {
    if (!full) setSlot(ref.current?.offsetHeight ?? 0)
    setFull((f) => !f)
  }
  return { ref, full, slot, toggle, close: () => setFull(false) }
}

export function ExpandButton({ full, onClick }: { full: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={full ? 'Make smaller' : 'Expand'} title={full ? 'Make smaller' : 'Expand'}
      className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] border border-line text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink">
      {full ? <X size={15} /> : <ArrowsOutSimple size={15} />}
    </button>
  )
}

export function ExpandOverlay({ full, slot, onClose, children }: { full: boolean; slot: number; onClose: () => void; children: ReactNode }) {
  if (!full) return children
  return (
    <>
      <div aria-hidden style={{ height: slot }} />
      <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
        {children}
      </div>
    </>
  )
}

/** Card classes for closed and open states. */
export const cardClass = (full: boolean) =>
  `panel flex flex-col bg-surface p-5 ${full ? 'w-full max-w-[1335px] shadow-[0_24px_64px_rgb(0_0_0/0.6)]' : 'h-[450px]'}`
