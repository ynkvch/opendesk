import { ArrowCounterClockwise, CaretDown, CaretUp, CheckSquare, DotsSixVertical, Minus, Plus, Square } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { regimeApi, type Regime, type RegimeFormula } from '../lib/regime'

const MINUS = '−'
const fmt = (v: number) => `${v < 0 ? MINUS : ''}${+Math.abs(v).toFixed(2)}`
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** a number box that keeps what is being typed (like "-" or "0.") and passes on each value that parses. */
function NumField({ value, min, max, step, onChange, className }: {
  value: number; min: number; max: number; step: number; onChange: (v: number) => void; className: string
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => { if (parseFloat(text) !== value) setText(String(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input type="number" inputMode="decimal" min={min} max={max} step={step} value={text} className={className}
      onChange={(e) => {
        setText(e.target.value)
        const v = parseFloat(e.target.value)
        if (!Number.isNaN(v)) onChange(clamp(v, min, max))
      }}
      onBlur={() => setText(String(value))} />
  )
}

/**
 * the regime score's formula: which signals count and in what order, their weights, which half of a pair counts
 * and the band between risk-on, neutral and risk-off. every change is
 * saved on the server a moment after it is made, so the score, the page and the notifications all use it.
 */
export function FormulaEditor({ score, onSaved }: { score: Regime['score']; onSaved: (r: Regime) => void }) {
  const [f, setF] = useState<RegimeFormula>(score.formula)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const pending = useRef<RegimeFormula | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const dragFrom = useRef<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const titles = new Map(score.families.map((x) => [x.key, x]))

  const save = (next: RegimeFormula) => {
    pending.current = null
    setStatus('saving')
    regimeApi.saveFormula(next).then((r) => { onSaved(r); setStatus('saved') }).catch(() => setStatus('error'))
  }
  // save shortly after the last change, and right away if the pop-up closes first
  const change = (next: RegimeFormula) => {
    setF(next)
    pending.current = next
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => save(next), 350)
  }
  useEffect(() => () => {
    window.clearTimeout(timer.current)
    if (pending.current) save(pending.current)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const part = (i: number, patch: Partial<RegimeFormula['parts'][number]>) =>
    change({ ...f, parts: f.parts.map((p, k) => (k === i ? { ...p, ...patch } : p)) })
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= f.parts.length) return
    const parts = [...f.parts]
    const [p] = parts.splice(from, 1)
    parts.splice(to, 0, p)
    change({ ...f, parts })
  }
  const reset = () => {
    window.clearTimeout(timer.current)
    pending.current = null
    setStatus('saving')
    regimeApi.resetFormula()
      .then((r) => { setF(r.score.formula); onSaved(r); setStatus('saved') })
      .catch(() => setStatus('error'))
  }

  const active = f.parts.filter((p) => p.on && p.weight > 0)
  const total = active.reduce((s, p) => s + p.weight, 0)

  return (
    <div className="flex w-[460px] max-w-full flex-col gap-4 text-[12px]">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-medium text-ink">Score formula</div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-ink-3" aria-live="polite">
            {status === 'saving' ? 'Saving' : status === 'saved' ? 'Saved' : status === 'error' ? 'Could not save' : ''}
          </span>
          <button type="button" onClick={reset}
            className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-1 text-[11px] text-ink-3 hover:text-ink-2">
            <ArrowCounterClockwise size={12} />Reset
          </button>
        </div>
      </div>

      <p className="num -mt-2 rounded-[var(--radius-sm)] border border-line bg-bg px-2.5 py-2 leading-relaxed text-ink-2">
        {active.length
          ? <>Score = 100 × ({active.map((p, k) => (
              <span key={p.key}>{k ? ' + ' : ''}<span className="text-ink">{fmt(p.weight)}</span>×{titles.get(p.key)?.title}</span>
            ))}) ÷ {fmt(total)}</>
          : 'No signals count, so there is no score.'}
      </p>

      <div className="flex flex-col gap-1.5">
        <div className="text-[11px] text-ink-3">Signals: drag or use the arrows to reorder, untick to leave one out</div>
        <ol className="flex flex-col gap-1">
          {f.parts.map((p, i) => {
            const fam = titles.get(p.key)
            const pair = (fam?.members.length ?? 0) > 1
            return (
              <li key={p.key} draggable
                onDragStart={(e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move' }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(i) }}
                onDragLeave={() => setDragOver((d) => (d === i ? null : d))}
                onDrop={(e) => { e.preventDefault(); if (dragFrom.current != null) move(dragFrom.current, i); dragFrom.current = null; setDragOver(null) }}
                onDragEnd={() => { dragFrom.current = null; setDragOver(null) }}
                className={`flex flex-col gap-1.5 rounded-[var(--radius-sm)] border bg-bg px-2 py-1.5 ${
                  dragOver === i ? 'border-line-strong' : 'border-line'} ${p.on ? '' : 'opacity-60'}`}>
                <div className="flex items-center gap-2">
                  <DotsSixVertical size={14} className="shrink-0 cursor-grab text-ink-3" aria-hidden />
                  <button type="button" role="checkbox" aria-checked={p.on} onClick={() => part(i, { on: !p.on })}
                    className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-left text-ink">
                    {p.on ? <CheckSquare size={15} weight="fill" className="shrink-0" /> : <Square size={15} className="shrink-0 text-ink-3" />}
                    <span className="truncate">{fam?.title ?? p.key}</span>
                  </button>
                  <div className="flex items-center rounded-[var(--radius-sm)] border border-line" aria-label={`Weight of ${fam?.title}`}>
                    <button type="button" aria-label="Lower weight" disabled={!p.on || p.weight <= 0}
                      onClick={() => part(i, { weight: clamp(p.weight - 0.5, 0, 5) })}
                      className="px-1.5 py-1 text-ink-3 hover:text-ink disabled:opacity-40"><Minus size={11} /></button>
                    <span className="num w-9 text-center text-ink">×{fmt(p.weight)}</span>
                    <button type="button" aria-label="Raise weight" disabled={!p.on || p.weight >= 5}
                      onClick={() => part(i, { weight: clamp(p.weight + 0.5, 0, 5) })}
                      className="px-1.5 py-1 text-ink-3 hover:text-ink disabled:opacity-40"><Plus size={11} /></button>
                  </div>
                  <div className="flex flex-col">
                    <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}
                      className="text-ink-3 hover:text-ink disabled:opacity-30"><CaretUp size={11} /></button>
                    <button type="button" aria-label="Move down" disabled={i === f.parts.length - 1} onClick={() => move(i, i + 1)}
                      className="text-ink-3 hover:text-ink disabled:opacity-30"><CaretDown size={11} /></button>
                  </div>
                </div>
                {pair && p.on && (
                  <div className="flex flex-wrap items-center gap-1.5 pl-[22px]">
                    <span className="text-[11px] text-ink-3">Average of</span>
                    {fam!.members.map((m) => {
                      const on = p.members[m.key] !== false
                      const others = fam!.members.filter((x) => x.key !== m.key && p.members[x.key] !== false).length
                      return (
                        <button key={m.key} type="button" role="checkbox" aria-checked={on} disabled={on && !others}
                          title={on && !others ? 'At least one has to count; untick the signal to leave it out' : undefined}
                          onClick={() => part(i, { members: { ...p.members, [m.key]: !on } })}
                          className={`rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-[11px] transition-colors ${
                            on ? 'border-line-strong bg-surface-3 text-ink' : 'border-line text-ink-3 hover:text-ink-2'}`}>
                          {m.label}
                        </button>
                      )
                    })}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      </div>

      <label className="flex flex-wrap items-center gap-1.5 text-ink-2">
        Risk-on at +
        <NumField min={1} max={100} step={5} value={f.band}
          onChange={(v) => change({ ...f, band: v })}
          className="num w-14 rounded-[var(--radius-sm)] border border-line bg-bg px-2 py-1 text-ink outline-none focus:border-line-strong" />
        or more, risk-off at {MINUS}{fmt(f.band)} or less, neutral between.
      </label>
    </div>
  )
}
