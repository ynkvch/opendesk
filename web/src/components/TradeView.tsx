import { CaretLeft, CaretRight, X } from '@phosphor-icons/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { DecayChart } from '../charts/DecayChart'
import { PayoffChart } from '../charts/PayoffChart'
import { RiskHeatmap } from './RiskHeatmap'
import { api, type Theta, type ThetaClose, type ThetaDay, type TradeDetail } from '../lib/api'
import {
  date, dateTime, dateYear, hold, money, num, pct, rMult, signedMoney, tone, vol,
} from '../lib/format'
import { extremes, type Position } from '../lib/payoff'
import { ErrorNote, Heading, Skeleton } from './ui'

type Props = {
  id: number
  /** Trade ids in the order of the list the trade was opened from. */
  order: number[]
  onClose: () => void
  onGo: (id: number) => void
  onSaved: () => void
}

/** Full-screen trade page. Esc closes; left/right arrows move through the list. */
export function TradeView({ id, order, onClose, onGo, onSaved }: Props) {
  const [trade, setTrade] = useState<TradeDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const idx = order.indexOf(id)
  const prev = idx > 0 ? order[idx - 1] : null
  const next = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null

  useEffect(() => {
    let live = true
    setError(null)
    api.trade(id).then((t) => live && setTrade(t)).catch((e: Error) => live && setError(e.message))
    return () => { live = false }
  }, [id, reload])

  useEffect(() => {
    rootRef.current?.focus()
    rootRef.current?.scrollTo({ top: 0 })
  }, [id])

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prevOverflow }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = (e.target as HTMLElement).closest('textarea, input')
      if (e.key === 'Escape') { onClose(); return }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowLeft' && prev != null) { e.preventDefault(); onGo(prev) }
      if (e.key === 'ArrowRight' && next != null) { e.preventDefault(); onGo(next) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onGo, prev, next])

  const t = trade && trade.id === id ? trade : null

  return (
    <div ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true"
      aria-label={t ? `${t.underlying} ${t.strategy}` : 'Trade'}
      className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-bg outline-none animate-[fade_180ms_var(--ease-out-quint)]">
      <div className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between gap-4 px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <IconButton label="Close (Esc)" onClick={onClose}><X size={16} /></IconButton>
            {t && (
              <span className="truncate text-[13px] text-ink-2">
                <span className="font-semibold text-ink">{t.underlying}</span> {t.strategy}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {idx >= 0 && (
              <span className="num mr-1 hidden text-xs text-ink-3 sm:inline">{idx + 1} / {order.length}</span>
            )}
            <IconButton label="Previous trade (←)" disabled={prev == null} onClick={() => prev != null && onGo(prev)}>
              <CaretLeft size={14} />
            </IconButton>
            <IconButton label="Next trade (→)" disabled={next == null} onClick={() => next != null && onGo(next)}>
              <CaretRight size={14} />
            </IconButton>
            <span className="ml-2 hidden text-xs text-ink-3 lg:inline">← → to move, Esc to close</span>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1400px] px-4 pb-24 pt-6 md:px-8">
        {error && <ErrorNote message={error} onRetry={() => setReload((n) => n + 1)} />}
        {!error && !t && <ViewSkeleton />}
        {t && <Body t={t} onSaved={(nt) => { setTrade(nt); onSaved() }} />}
      </div>
    </div>
  )
}

function IconButton({ label, onClick, children, disabled = false }: {
  label: string
  onClick: () => void
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-sm)] border border-line text-ink-2 transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-ink active:translate-y-px disabled:pointer-events-none disabled:opacity-35">
      {children}
    </button>
  )
}

function ViewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading trade">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-12 w-48" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    </div>
  )
}

function Panel({ title, children, right, cut = false }: { title: string; children: ReactNode; right?: ReactNode; cut?: boolean }) {
  return (
    <section className={`panel ${cut ? 'panel-cut' : ''} p-5`}>
      <Heading right={right}>{title}</Heading>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function Cell({ label, value, sub, className = 'text-ink' }: {
  label: string
  value: ReactNode
  sub?: ReactNode
  className?: string
}) {
  return (
    <div className="rounded-[var(--radius-sm)] bg-surface-2 px-3 py-2.5">
      <div className="text-xs text-ink-3">{label}</div>
      <div className={`num mt-1 text-[15px] ${className}`}>{value}</div>
      {sub && <div className="num mt-0.5 text-xs text-ink-3">{sub}</div>}
    </div>
  )
}

function Body({ t, onSaved }: { t: TradeDetail; onSaved: (t: TradeDetail) => void }) {
  const closed = t.status === 'closed'
  const stock = t.asset === 'STK'
  const kept = t.pnl != null && t.pnl > 0 && t.mfe > 0 ? t.pnl / t.mfe : null
  const offHigh = t.pnl != null ? t.mfe - t.pnl : null
  const undMove = (v: number) => pct((v - t.und_entry) / t.und_entry, 2, true)

  const payoff = useMemo(() => {
    const legs = t.legs.map((l) => ({ side: l.side, right: l.right_, strike: l.strike, expiry: l.expiry, iv: l.iv_entry }))
    const position: Position = { legs, entry: t.entry_price, quantity: t.quantity, multiplier: t.multiplier, commissions: t.commissions }
    // Second curve: at the exit for closed trades, at the latest update for open ones.
    const ivScale = t.iv_last && t.iv_entry ? t.iv_last / t.iv_entry : 1
    const atLegs = t.legs.map((l, i) => ({ ...legs[i], iv: closed ? (l.iv_exit ?? l.iv_entry) : l.iv_entry * ivScale }))
    const at = new Date((closed ? t.closed_at : t.last_update) ?? Date.now()).getTime()
    const spot = closed ? t.und_exit : t.und_last
    return {
      position,
      atPosition: { ...position, legs: atLegs },
      at,
      spot,
      ext: extremes(position),
    }
  }, [t, closed])

  const expiry = t.legs[0]?.expiry
  // the risk grid centres on the latest price: IBKR's pre/post-market underlying when that is newer than the last mark
  const riskSpot = t.model_und != null && t.model_at && (!t.last_update || t.model_at > t.last_update) ? t.model_und : payoff.spot

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-6 pb-2">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-3xl font-semibold tracking-[-0.03em]">{t.underlying}</h2>
            <span className="text-[15px] text-ink-2">{t.strategy}</span>
            <span className="rounded-[3px] border border-line-strong px-1.5 py-px text-[11px] text-ink">{closed ? 'Closed' : 'Open'}</span>
          </div>
          <p className="mt-1 text-[13px] text-ink-3">
            {stock ? <span className="num">{t.quantity} shares</span> : <><span className="code">{t.contract}</span> · x{t.quantity}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
          <div>
            <div className="text-xs text-ink-3">{closed ? 'Realized P&L' : 'Unrealized P&L'}</div>
            <div className={`num mt-1 text-4xl tracking-[-0.03em] ${tone(t.pnl)}`}>{signedMoney(t.pnl, 2)}</div>
          </div>
          {!closed && t.model_at && t.model_pnl != null && (!t.last_update || t.model_at > t.last_update) && (
            <div>
              <div className="text-xs text-ink-3">IBKR model, outside market hours</div>
              <div className={`num mt-1 text-2xl tracking-[-0.02em] ${tone(t.model_pnl)}`}>{signedMoney(t.model_pnl, 2)}</div>
              <div className="num mt-0.5 text-xs text-ink-3">
                mark {num(t.model_mark)}{t.model_und != null && <> · {t.underlying} {num(t.model_und)}</>} · {dateTime(t.model_at)}
              </div>
            </div>
          )}
          <div className="text-[13px] text-ink-3">
            <div><span className={`num ${tone(t.r_multiple)}`}>{rMult(t.r_multiple)}</span> on <span className="num text-ink-2">{money(t.max_risk)}</span> {stock ? 'invested' : 'max risk'}</div>
            <div className="mt-0.5">
              {t.open_estimated
                ? <>Bought before <span className="num text-ink-2">{dateYear(t.opened_at)}</span></>
                : <span className="num text-ink-2">{dateTime(t.opened_at)}</span>}
              {closed && t.closed_at
                ? <> to <span className="num text-ink-2">{dateTime(t.closed_at)}</span>, held{t.open_estimated ? ' at least' : ''} <span className="num text-ink-2">{hold(t.hold_hours)}</span></>
                : ', still open'}
            </div>
          </div>
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="min-w-0 space-y-4">
          <Panel title={stock ? 'P&L by price' : 'Payoff'} cut right={stock ? undefined :
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3" aria-label="Legend">
              <li className="flex items-center gap-1.5"><span aria-hidden className="h-0.5 w-4 rounded-full bg-ink" />At expiry{expiry && `, ${dateYear(expiry)}`}</li>
              <li className="flex items-center gap-1.5">
                <svg aria-hidden width="16" height="2"><line x1="0" x2="16" y1="1" y2="1" stroke="var(--color-ink-2)" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
                {closed ? 'At exit' : 'Now'}
              </li>
            </ul>}>
            <PayoffChart
              position={payoff.position}
              atPosition={payoff.atPosition}
              at={payoff.at}
              atLabel={closed ? 'At exit' : 'Now'}
              entrySpot={t.und_entry}
              mark={payoff.spot != null && t.pnl != null ? { spot: payoff.spot, pnl: t.pnl, label: closed ? 'Exit' : 'Now' } : null}
              include={[t.und_high, t.und_low, ...(payoff.spot != null ? [payoff.spot] : [])]}
              single={stock}
            />
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Cell label={stock ? 'Max profit' : 'Max profit at expiry'} value={payoff.ext.maxProfit == null ? 'Unlimited' : signedMoney(payoff.ext.maxProfit)}
                className={payoff.ext.maxProfit == null ? 'text-ink' : tone(payoff.ext.maxProfit)} />
              <Cell label={stock ? 'Max loss' : 'Max loss at expiry'} value={payoff.ext.maxLoss == null ? 'Unlimited' : signedMoney(payoff.ext.maxLoss)}
                className={payoff.ext.maxLoss == null ? 'text-ink' : tone(payoff.ext.maxLoss)} />
              <Cell label={stock ? (t.open_estimated ? 'Cost basis' : 'Entry') : 'Net debit'} value={num(t.entry_price)} sub="per share" />
              <Cell label={closed ? `${t.underlying} at exit` : `${t.underlying} now`}
                value={payoff.spot == null ? '-' : num(payoff.spot)} sub={payoff.spot == null ? undefined : undMove(payoff.spot)} />
            </div>
            <p className="mt-3 text-xs text-ink-3">
              {stock
                ? `P&L for ${t.quantity} shares at each price, after commissions.`
                : `Built from the legs and fill prices of this trade. The dashed curve uses ${closed ? 'IV at exit' : 'the latest IV'} and Black-Scholes.`}
            </p>
          </Panel>

          {!stock && !closed && riskSpot != null && (
            <Panel title="Risk navigator" right={<span className="text-xs text-ink-3">P&L by price and vol</span>}>
              <RiskHeatmap position={payoff.atPosition} spot={riskSpot} underlying={t.underlying} />
            </Panel>
          )}

          <Panel title="Excursion">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Cell label="MAE" value={signedMoney(t.mae)} className={tone(t.mae)} sub={rMult(t.mae / t.max_risk)} />
              <Cell label="MFE" value={signedMoney(t.mfe)} className={tone(t.mfe)} sub={rMult(t.mfe / t.max_risk)} />
              <Cell label="Kept of MFE" value={kept == null ? '-' : pct(kept, 0)}
                sub={offHigh == null ? undefined : `${money(offHigh)} off the high`} />
              <Cell label={`${t.underlying} at entry / exit`}
                value={<>{num(t.und_entry)}<span className="text-ink-3"> / </span>{t.und_exit == null ? '-' : num(t.und_exit)}</>}
                sub={t.und_exit == null ? undefined : undMove(t.und_exit)} />
              <Cell label={`${t.underlying} high in trade`} value={num(t.und_high)} sub={undMove(t.und_high)} />
              <Cell label={`${t.underlying} low in trade`} value={num(t.und_low)} sub={undMove(t.und_low)} />
              <Cell label={stock ? 'Price in / out' : 'Position entry / exit'}
                value={<>{num(t.entry_price)}<span className="text-ink-3"> / </span>{t.exit_price == null ? '-' : num(t.exit_price)}</>}
                sub="per share, net" />
              <Cell label="Position high" value={num(t.pos_high)} sub={pct((t.pos_high - t.entry_price) / t.entry_price, 0, true)} />
              <Cell label="Position low" value={num(t.pos_low)} sub={pct((t.pos_low - t.entry_price) / t.entry_price, 0, true)} />
            </div>
          </Panel>

          {!stock && <Panel title="Greeks and volatility" right={<span className="text-xs text-ink-3">Position, USD</span>}>
            <table className="w-full text-[13px]">
              <thead className="text-xs text-ink-3">
                <tr className="h-8 border-b border-line text-right">
                  <th scope="col" className="text-left font-normal"><span className="sr-only">Measure</span></th>
                  <th scope="col" className="font-normal">Entry</th>
                  <th scope="col" className="font-normal">Exit</th>
                  <th scope="col" className="font-normal">Change</th>
                </tr>
              </thead>
              <tbody className="num">
                <GreekRow label="Delta" a={t.delta_entry} b={t.delta_exit} d={1} hint="$ per $1 move" />
                <GreekRow label="Gamma" a={t.gamma_entry} b={t.gamma_exit} d={2} hint="delta per $1" />
                <GreekRow label="Theta" a={t.theta_entry} b={t.theta_exit} d={2} hint="$ per day" />
                <GreekRow label="Vega" a={t.vega_entry} b={t.vega_exit} d={2} hint="$ per vol pt" />
                <GreekRow label="IV, main leg" a={t.iv_entry * 100} b={t.iv_exit == null ? null : t.iv_exit * 100} d={1} hint="vol pts" />
              </tbody>
            </table>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Cell label="IV rank at entry" value={t.iv_rank_entry == null ? '-' : num(t.iv_rank_entry, 0)} />
              <Cell label="HV20 at entry" value={vol(t.hv20_entry)} />
              <Cell label="IV minus HV20" value={t.hv20_entry == null ? '-' : num((t.iv_entry - t.hv20_entry) * 100, 1, true)} sub="vol pts" />
              <Cell label="DTE at entry" value={t.dte_entry} sub="days" />
            </div>
          </Panel>}

          {!stock && <ThetaPanel t={t} />}
        </div>

        <div className="min-w-0 space-y-4">
          <Panel title="Legs">
            <ul className="space-y-2">
              {t.legs.map((l) => (
                <li key={l.id} className="rounded-[var(--radius-sm)] bg-surface-2 px-3 py-2.5 text-[13px]">
                  <div className="flex items-baseline justify-between gap-3">
                    <span>
                      <span className={l.side === 'BUY' ? 'text-ink' : 'text-ink-2'}>{l.side === 'BUY' ? 'Long' : 'Short'}</span>
                      <span className="num ml-1.5 text-ink">{l.right_ === 'S' ? `${t.quantity} shares` : `${l.strike} ${l.right_ === 'C' ? 'call' : 'put'}`}</span>
                    </span>
                    {l.right_ !== 'S' && <span className="num text-xs text-ink-3">{dateYear(l.expiry)}</span>}
                  </div>
                  {l.right_ === 'S' ? (
                    <dl className="num mt-2 grid grid-cols-3 gap-2 text-xs">
                      <div><dt className="text-ink-3">Price in / out</dt><dd className="mt-0.5 text-ink-2">{num(l.entry_price)} / {l.exit_price == null ? '-' : num(l.exit_price)}</dd></div>
                      <div><dt className="text-ink-3">Invested</dt><dd className="mt-0.5 text-ink-2">{money(l.entry_price * t.quantity, 2)}</dd></div>
                      <div><dt className="text-ink-3">Proceeds</dt><dd className="mt-0.5 text-ink-2">{l.exit_price == null ? '-' : money(l.exit_price * t.quantity, 2)}</dd></div>
                    </dl>
                  ) : (
                  <dl className="num mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div><dt className="text-ink-3">Price in / out</dt><dd className="mt-0.5 text-ink-2">{num(l.entry_price)} / {l.exit_price == null ? '-' : num(l.exit_price)}</dd></div>
                    <div><dt className="text-ink-3">IV in / out</dt><dd className="mt-0.5 text-ink-2">{vol(l.iv_entry)} / {vol(l.iv_exit)}</dd></div>
                    <div><dt className="text-ink-3">Delta in / out</dt><dd className="mt-0.5 text-ink-2">{num(l.delta_entry)} / {l.delta_exit == null ? '-' : num(l.delta_exit)}</dd></div>
                  </dl>
                  )}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Executions" right={<span className="num text-xs text-ink-3">{money(t.commissions, 2)} fees</span>}>
            <ol className="space-y-2">
              {t.fills.map((f) => (
                <li key={f.id} className="rounded-[var(--radius-sm)] bg-surface-2 px-3 py-2.5 text-[13px]">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0">
                      <span className={`mr-2 text-xs ${f.side === 'BOT' ? 'text-ink' : 'text-ink-2'}`}>{f.side === 'BOT' ? 'Bought' : 'Sold'}</span>
                      <span className="text-ink-2"><span className="num">{f.quantity}</span> x <span className="code">{f.description}</span></span>
                    </span>
                    <span className="num text-ink">{num(f.price)}</span>
                  </div>
                  <div className="mt-1 flex justify-between gap-3 text-[11px] text-ink-3">
                    <span className="num">{dateTime(f.time)}, {f.action === 'OPEN' ? 'opening' : 'closing'}</span>
                    <span className="num">{f.commission ? `${money(f.commission, 2)} commission` : 'no commission'}</span>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>

          <Notes t={t} onSaved={onSaved} />
        </div>
      </div>
    </div>
  )
}

/** How much faster than the last close's theta counts as theta speeding up. */
const ACCEL = 1.5
const SPEED_UP = 'var(--color-warn)'
const HALF = 'var(--color-info)'
/** Share of the premium paid that theta has to take for the third reference date. */
const PREMIUM_SHARE = 0.4
const PREMIUM_LINE = 'var(--color-violet)'

/**
 * Running total of theta: each close's theta counts for every calendar day until the next close, then the
 * projected daily decay. Returns what was taken up to the last close and the first day the total reaches `target`.
 */
function thetaTaken(history: ThetaClose[], projection: ThetaDay[], target: number) {
  let total = 0
  let hit: string | null = null
  history.forEach((h, i) => {
    const next = history[i + 1]
    if (h.theta == null || !next) return
    const days = Math.round((new Date(next.date).getTime() - new Date(h.date).getTime()) / 86_400_000)
    const rate = -h.theta
    if (hit == null && rate > 0 && total + rate * days >= target) {
      const d = new Date(h.date)
      d.setUTCDate(d.getUTCDate() + Math.ceil((target - total) / rate))
      hit = d.toISOString().slice(0, 10)
    }
    total += rate * days
  })
  const soFar = total
  for (const p of projection) {
    total += p.decay
    if (hit == null && total >= target) hit = p.date
  }
  return { soFar, hit: hit as string | null, total }
}

/** A metric drawn as a dashed line on the chart above; the swatch ties the two together. */
function MarkerCell({ color, label, value, sub }: { color: string; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[var(--radius-sm)] bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs text-ink-3">
        <svg aria-hidden width="4" height="14" className="shrink-0">
          <line x1="2" x2="2" y1="0" y2="14" stroke={color} strokeWidth="2" strokeDasharray="3 2" />
        </svg>
        {label}
      </div>
      <div className="num mt-1 text-[15px] text-ink">{value}</div>
      {sub && <div className="num mt-0.5 text-xs text-ink-3">{sub}</div>}
    </div>
  )
}

/** Extrinsic value left at each close, what theta takes each day, and the path to expiry from the latest close. */
function ThetaPanel({ t }: { t: TradeDetail }) {
  const [data, setData] = useState<Theta | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setData(null)
    setError(null)
    api.theta(t.id).then((d) => live && setData(d)).catch((e: Error) => live && setError(e.message))
    return () => { live = false }
  }, [t.id, t.last_update])

  if (error) return <Panel title="Time value and theta"><ErrorNote message={error} /></Panel>
  if (!data) return <Panel title="Time value and theta"><Skeleton className="h-80" /></Panel>
  if (!data.available) return null

  const last = [...data.history].reverse().find((h) => h.iv != null) ?? null
  const first = data.history[0] ?? null
  const start = data.extrinsic_entry ?? first?.extrinsic ?? null
  const now = last?.extrinsic ?? null
  const today = new Date().toISOString().slice(0, 10)
  const left = Math.max(0, Math.round((new Date(data.expiry).getTime() - new Date(today).getTime()) / 86_400_000))
  const eatenSoFar = start != null && now != null ? start - now : null
  // when the daily decay first reaches 1.5x the theta at the last close, and when half the extrinsic left is gone
  const base = last?.theta != null ? -last.theta : null
  const speedUp = base == null ? null : data.projection.find((d) => d.decay >= ACCEL * base) ?? null
  const half = now == null ? null : data.projection.find((d) => d.extrinsic <= now / 2) ?? null
  const before = (d: string) => Math.round((new Date(data.expiry).getTime() - new Date(d).getTime()) / 86_400_000)
  const premium = t.entry_price * t.multiplier * t.quantity
  const share = thetaTaken(data.history, data.projection, PREMIUM_SHARE * premium)
  const markers = [
    ...(speedUp ? [{ date: speedUp.date, color: SPEED_UP }] : []),
    ...(half ? [{ date: half.date, color: HALF }] : []),
    ...(share.hit ? [{ date: share.hit, color: PREMIUM_LINE }] : []),
  ]

  return (
    <Panel title="Time value and theta" right={
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span aria-hidden className="h-0.5 w-4 rounded-full bg-ink" />At each close</li>
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="16" height="2"><line x1="0" x2="16" y1="1" y2="1" stroke="var(--color-ink-2)" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
          Projected
        </li>
      </ul>}>
      {data.history.length + data.projection.length < 2 ? (
        <p className="text-[13px] text-ink-3">No session closes recorded yet. They appear after the next TWS sync.</p>
      ) : (
        <DecayChart history={data.history} projection={data.projection} markers={markers}
          ariaLabel={`Extrinsic value of the position falling from ${money(start)} to zero at expiry, with theta per day below`} />
      )}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Cell label="Extrinsic at last close" value={money(now, 2)} sub={last ? date(last.date) : undefined} />
        <Cell label="Theta at last close" value={last?.theta == null ? '-' : `${money(last.theta, 2)}/day`} className="text-neg" />
        <Cell label={data.extrinsic_entry != null ? 'Extrinsic lost since entry' : 'Extrinsic lost since first close'}
          value={eatenSoFar == null ? '-' : money(eatenSoFar, 2)}
          sub={eatenSoFar == null || !start ? undefined : `${pct(eatenSoFar / start, 0)} of ${money(start)}`} />
        <Cell label="Days to expiry" value={left} sub={dateYear(data.expiry)} />
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <MarkerCell color={SPEED_UP} label={`Theta reaches ${ACCEL}x the last close's rate`}
          value={speedUp ? dateYear(speedUp.date) : '-'}
          sub={speedUp && base != null ? `${before(speedUp.date)} days before expiry; ${money(speedUp.decay, 2)}/day vs ${money(base, 2)}/day now` : undefined} />
        <MarkerCell color={HALF} label="Half of the extrinsic left is gone by"
          value={half ? dateYear(half.date) : '-'}
          sub={half && now != null ? `${before(half.date)} days before expiry; ${money(now / 2)} of ${money(now)}` : undefined} />
        <MarkerCell color={PREMIUM_LINE} label={`Theta takes ${pct(PREMIUM_SHARE, 0)} of the premium paid by`}
          value={share.hit ? dateYear(share.hit) : 'Not before expiry'}
          sub={share.hit
            ? `${before(share.hit)} days before expiry; ${money(PREMIUM_SHARE * premium)} of ${money(premium)}; ${money(share.soFar)} taken so far`
            : `Projected theta adds up to ${money(share.total)} of ${money(premium)}`} />
      </div>
      <p className="mt-3 text-xs text-ink-3">
        Extrinsic is the option price minus its intrinsic value, for the whole position. Closes come from the TWS sync during
        US market hours; the last sync of the session sets the close. The projection holds {t.underlying} at{' '}
        <span className="num">{last ? num(last.underlying) : '-'}</span> and IV at <span className="num">{vol(last?.iv)}</span> from
        the last close and uses Black-Scholes, counting every calendar day, so both dates move as the price and IV move.
        Past the first date each day costs more than now; they describe the decay, not when to exit.
        "Theta takes" adds up each close's theta for every calendar day to the next close, then the projected decay; it counts
        time alone, not price or IV moves, and the premium is the entry price for the whole position before commissions. "Lost since entry" also includes moves in price and IV.
      </p>
    </Panel>
  )
}

function GreekRow({ label, a, b, d, hint }: { label: string; a: number; b: number | null; d: number; hint: string }) {
  return (
    <tr className="h-10 border-b border-line text-right last:border-b-0">
      <th scope="row" className="text-left font-sans font-normal">
        <span className="text-ink">{label}</span>
        <span className="ml-2 text-xs text-ink-3">{hint}</span>
      </th>
      <td className="text-ink">{num(a, d)}</td>
      <td className="text-ink-2">{b == null ? '-' : num(b, d)}</td>
      <td className="text-ink-3">{b == null ? '-' : num(b - a, d, true)}</td>
    </tr>
  )
}

/** A textarea that grows to fit its text; `rows` sets the minimum height. */
function GrowingTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [props.value])
  return <textarea ref={ref} {...props} />
}

/**
 * Thesis and post-mortem are the trader's own words. Both stay editable after the trade closes.
 */
function Notes({ t, onSaved }: { t: TradeDetail; onSaved: (t: TradeDetail) => void }) {
  const [thesis, setThesis] = useState(t.thesis)
  const [post, setPost] = useState(t.post_mortem)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const dirty = thesis !== t.thesis || post !== t.post_mortem

  useEffect(() => { setThesis(t.thesis); setPost(t.post_mortem); setState('idle') }, [t.id, t.thesis, t.post_mortem])

  async function save() {
    setState('saving')
    try {
      const nt = await api.saveNotes(t.id, { thesis, post_mortem: post })
      setState('saved')
      onSaved(nt)
    } catch {
      setState('error')
    }
  }

  const field = 'block w-full resize-none overflow-hidden rounded-[var(--radius-sm)] border border-line-strong bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-ink focus:border-ink-2 focus:outline-none'

  return (
    <Panel title="Journal">
      <div className="space-y-5">
        <div className="space-y-2">
          <label htmlFor={`thesis-${t.id}`} className="block text-[13px] text-ink">Thesis</label>
          <GrowingTextarea id={`thesis-${t.id}`} value={thesis} onChange={(e) => setThesis(e.target.value)}
            rows={4} aria-describedby={`thesis-help-${t.id}`} className={field} />
          <p id={`thesis-help-${t.id}`} className="text-xs text-ink-3">
            Why you are in this trade, written before the outcome is known.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor={`post-${t.id}`} className="block text-[13px] text-ink">Post-mortem</label>
          <GrowingTextarea id={`post-${t.id}`} value={post} onChange={(e) => setPost(e.target.value)} rows={4}
            aria-describedby={`post-help-${t.id}`} className={field} />
          <p id={`post-help-${t.id}`} className="text-xs text-ink-3">
            What happened against the thesis, and what you would repeat or change.
          </p>
        </div>

        <div className="flex items-center justify-end gap-3">
          {state === 'saved' && !dirty && <span className="text-xs text-ink-3">Saved</span>}
          {state === 'error' && <span className="text-xs text-neg">Could not save. Try again.</span>}
          <button type="button" onClick={save} disabled={!dirty || state === 'saving'}
            className="h-8 rounded-[var(--radius-md)] bg-ink px-4 text-xs font-medium text-bg transition-opacity hover:opacity-90 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40">
            {state === 'saving' ? 'Saving' : 'Save notes'}
          </button>
        </div>
      </div>
    </Panel>
  )
}
