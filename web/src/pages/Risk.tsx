import { ArrowsClockwise, MagnifyingGlass } from '@phosphor-icons/react'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { ErrorNote, Heading, Segmented, Skeleton } from '../components/ui'
import { money, num, signedMoney } from '../lib/format'
import { bsPrice, scenarioPnl } from '../lib/payoff'
import { riskApi, timeSteps, type MarketSession, type RiskOverview, type RiskQuote } from '../lib/risk'
import { navigate } from '../lib/router'
import { VOL_COLORS } from '../charts/VolCharts'
import { expiryLabel } from '../lib/vol'

const PRICE_STEPS = Array.from({ length: 21 }, (_, i) => i - 10)
const VOL_STEPS = [30, 25, 20, 15, 10, 5, 0, -5, -10, -15, -20, -25, -30]
const YEAR_MS = 365 * 86_400_000
const LAST_TICKER = 'risk.lastTicker'

type Right = 'C' | 'P'
type Side = 'BUY' | 'SELL'
type Fill = 'model' | 'bid' | 'mid' | 'ask' | 'custom'

const inputClass = 'h-8 w-full rounded-[var(--radius-md)] border border-line bg-bg px-2.5 text-[13px] text-ink outline-none focus:border-line-strong num'

/** Risk manager: pick a contract, read its quote from TWS, and see its P&L across price, vol and time. */
export function RiskPage({ path }: { path: string }) {
  const symbol = decodeURIComponent(path.split('/')[2] ?? '').toUpperCase()
  const [input, setInput] = useState('')
  const [overview, setOverview] = useState<RiskOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function load() {
    if (!symbol) return
    setLoading(true)
    setError(null)
    riskApi.overview(symbol).then(setOverview).catch((e: Error) => setError(e.message)).finally(() => setLoading(false))
  }
  useEffect(() => { setOverview(null); load() }, [symbol]) // eslint-disable-line react-hooks/exhaustive-deps

  // remember the ticker, and reopen it when the tab is opened without one
  useEffect(() => {
    try {
      if (symbol) localStorage.setItem(LAST_TICKER, symbol)
      else {
        const last = localStorage.getItem(LAST_TICKER)
        if (last) navigate(`/risk/${encodeURIComponent(last)}`, { replace: true })
      }
    } catch { /* storage blocked: start empty */ }
  }, [symbol])

  function submit(e: FormEvent) {
    e.preventDefault()
    const s = input.trim().toUpperCase()
    if (s) navigate(`/risk/${encodeURIComponent(s)}`)
    setInput('')
  }

  const o = overview?.symbol === symbol ? overview : null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">Risk manager</h1>
          <form onSubmit={submit} className="flex items-center gap-2" role="search">
            <label className="relative">
              <span className="sr-only">Ticker</span>
              <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <input id="risk-ticker" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ticker, e.g. NVDA" autoCapitalize="characters" spellCheck={false}
                className="h-8 w-44 rounded-[var(--radius-md)] border border-line bg-bg pl-8 pr-2 text-[13px] uppercase text-ink placeholder:normal-case placeholder:text-ink-3 outline-none focus:border-line-strong" />
            </label>
            <button type="submit" className="h-8 rounded-[var(--radius-md)] border border-line-strong px-3 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink active:translate-y-px">Load</button>
          </form>
          {symbol && (
            <span className="num inline-flex h-8 items-center rounded-[var(--radius-md)] border border-line-strong bg-surface-3 px-2.5 text-[12px] text-ink">{symbol}</span>
          )}
        </div>
        {o && (
          <div className="flex items-center gap-4 text-xs text-ink-3">
            <Dot color={o.data_type === 'live' ? 'var(--color-pos)' : 'var(--color-warn)'}
              label={o.data_type === 'simulated' ? 'Simulated data' : o.data_type === 'delayed' ? 'TWS, delayed' : 'TWS'} />
            <Dot {...SESSION_DOT[o.session]} />
          </div>
        )}
      </div>

      {!symbol && (
        <div className="panel px-6 py-16 text-center">
          <p className="text-[15px] text-ink">Pick a ticker to price one of its options.</p>
          <p className="mx-auto mt-2 max-w-[60ch] text-[13px] text-ink-3">
            Choose the expiry and strike, read the bid, ask and IV from TWS, and see the P&L across price, vol and time, against your account size.
          </p>
        </div>
      )}
      {symbol && error && <ErrorNote message={error} onRetry={load} />}
      {symbol && !o && !error && (
        <div className="space-y-4" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      )}
      {o && <ContractRisk key={o.symbol} o={o} reloading={loading} onReload={load} />}
    </div>
  )
}

function ContractRisk({ o, reloading, onReload }: { o: RiskOverview; reloading: boolean; onReload: () => void }) {
  const [expiry, setExpiry] = useState(() =>
    o.expiries.reduce((a, b) => (Math.abs(b.dte - 30) < Math.abs(a.dte - 30) ? b : a), o.expiries[0])?.expiry ?? '')
  const [strikes, setStrikes] = useState<number[] | null>(null)
  const [strike, setStrike] = useState<number | null>(null)
  const [right, setRight] = useState<Right>('P')
  const [side, setSide] = useState<Side>('BUY')
  const [qty, setQty] = useState(1)
  const [quote, setQuote] = useState<RiskQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [fill, setFill] = useState<Fill>('mid')
  const [custom, setCustom] = useState('')
  const [ivInput, setIvInput] = useState('')
  const [commInput, setCommInput] = useState('')
  const [nlvInput, setNlvInput] = useState('')
  const [stamp, setStamp] = useState(0)

  // strikes for the chosen expiry, starting at the one nearest the money
  useEffect(() => {
    if (!expiry) return
    setStrikes(null)
    setQuoteError(null)
    riskApi.strikes(o.symbol, expiry).then((r) => {
      setStrikes(r.strikes)
      setStrike((cur) => (cur != null && r.strikes.includes(cur) ? cur
        : r.strikes.reduce((a, b) => (Math.abs(b - o.spot) < Math.abs(a - o.spot) ? b : a), r.strikes[0] ?? 0)))
    }).catch((e: Error) => setQuoteError(e.message))
  }, [o.symbol, o.spot, expiry])

  useEffect(() => {
    if (!expiry || strike == null || !strikes) return
    let live = true
    setQuoting(true)
    setQuoteError(null)
    riskApi.quote(o.symbol, expiry, strike, right)
      .then((q) => {
        if (!live) return
        setQuote(q); setIvInput(''); setCustom('')
        setFill(q.session === 'regular' ? 'mid' : 'model')
      })
      .catch((e: Error) => live && setQuoteError(e.message))
      .finally(() => live && setQuoting(false))
    return () => { live = false }
  }, [o.symbol, expiry, strike, right, strikes, stamp])

  const exp = o.expiries.find((e) => e.expiry === expiry)
  const spot = quote?.spot ?? o.spot
  const iv = ivInput !== '' ? parseFloat(ivInput) / 100 : quote?.iv ?? null
  // valuation moment: when the quote was read, so the heatmap's first step and the model price agree
  const now = useMemo(() => (quote ? Date.now() : 0), [quote])
  const expiresAt = exp ? new Date(exp.expires_at).getTime() : 0
  const model = exp && strike != null && iv != null && iv > 0 ? bsPrice(right, spot, strike, Math.max(0, (expiresAt - now) / YEAR_MS), iv) : null
  const priceOf = (f: Fill) => f === 'model' ? model : f === 'bid' ? quote?.bid : f === 'ask' ? quote?.ask : f === 'mid' ? quote?.mid ?? quote?.last : parseFloat(custom)
  const entry = priceOf(fill) ?? null
  const autoComm = o.commission.per_contract * qty * 2
  const comm = commInput !== '' ? parseFloat(commInput) || 0 : autoComm
  const nlv = nlvInput !== '' ? parseFloat(nlvInput) : o.account?.value ?? null
  const ready = exp && strike != null && entry != null && entry > 0 && iv != null && iv > 0

  return (
    <div className="space-y-6">
      <section className="panel space-y-5 p-5" aria-label="Contract">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-[1.3fr_1fr_auto_auto_0.7fr_auto]">
          <Field label="Expiry" htmlFor="risk-expiry">
            <select id="risk-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={inputClass}>
              {o.expiries.map((e) => <option key={e.expiry} value={e.expiry}>{expiryLabel(e.expiry, true)} · {e.dte} DTE</option>)}
            </select>
          </Field>
          <Field label="Strike" htmlFor="risk-strike">
            <select id="risk-strike" value={strike ?? ''} disabled={!strikes} onChange={(e) => setStrike(+e.target.value)} className={inputClass}>
              {!strikes && <option>Loading…</option>}
              {strikes?.map((k) => <option key={k} value={k}>{k % 1 ? k.toFixed(2) : k}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <Segmented<Right> label="Call or put" value={right} onChange={setRight} options={[{ value: 'C', label: 'Call' }, { value: 'P', label: 'Put' }]} />
          </Field>
          <Field label="Side">
            <Segmented<Side> label="Buy or sell" value={side} onChange={setSide} options={[{ value: 'BUY', label: 'Buy' }, { value: 'SELL', label: 'Sell' }]} />
          </Field>
          <Field label="Contracts" htmlFor="risk-qty">
            <input id="risk-qty" type="number" min={1} step={1} value={qty} onChange={(e) => setQty(Math.max(1, Math.round(+e.target.value) || 1))} className={inputClass} />
          </Field>
          <div className="flex items-end">
            <button type="button" onClick={() => { onReload(); setStamp((s) => s + 1) }} disabled={quoting || reloading} aria-busy={quoting || reloading}
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-line-strong px-3 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink active:translate-y-px disabled:cursor-wait disabled:opacity-60">
              <ArrowsClockwise size={13} className={quoting || reloading ? 'animate-spin' : ''} />{quoting ? 'Reading TWS…' : 'Reload'}
            </button>
          </div>
        </div>

        {quoteError && <ErrorNote message={quoteError} onRetry={() => setStamp((s) => s + 1)} />}

        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-md)] border border-line bg-line sm:grid-cols-4 lg:grid-cols-8">
          <Cell label={`${o.symbol} spot`} value={num(spot)} sub={o.close ? `${num((spot / o.close - 1) * 100, 1, true)}% today` : undefined} />
          <Cell label="Bid" value={quote ? num(quote.bid) : '…'} />
          <Cell label="Ask" value={quote ? num(quote.ask) : '…'} sub={quote?.bid && quote.ask && quote.mid ? `spread ${num((quote.ask - quote.bid) / quote.mid * 100, 1)}%` : undefined} />
          <Cell label="Mid" value={quote ? num(quote.mid ?? quote.last) : '…'} sub={quote && quote.mid == null && quote.last != null ? 'last trade' : undefined} />
          <Cell label="IV" value={quote?.iv != null ? `${(quote.iv * 100).toFixed(1)}%` : '…'} sub={quote?.iv_source ?? undefined} />
          <Cell label="Model" value={model != null ? num(model) : '…'} sub={model != null ? 'at spot and IV' : undefined} />
          <Cell label="Delta" value={quote?.delta != null ? num(quote.delta) : '…'} />
          <Cell label="Account" value={o.account ? money(o.account.value) : '-'} sub={o.account?.source} />
        </dl>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[auto_1fr_1fr_1fr]">
          <Field label={side === 'BUY' ? 'Entry, paid per share' : 'Entry, received per share'}>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented<Fill> label="Fill price" value={fill} onChange={setFill}
                options={[{ value: 'model', label: 'Model' }, { value: 'bid', label: 'Bid' }, { value: 'mid', label: 'Mid' }, { value: 'ask', label: 'Ask' }, { value: 'custom', label: 'Custom' }]} />
              {fill === 'custom' && (
                <input aria-label="Custom entry price" type="number" step={0.01} value={custom} placeholder={num(quote?.mid)} onChange={(e) => setCustom(e.target.value)} className={`${inputClass} w-24`} />
              )}
            </div>
          </Field>
          <Field label="IV for the model, %" htmlFor="risk-iv">
            <input id="risk-iv" type="number" step={0.1} value={ivInput} placeholder={quote?.iv != null ? (quote.iv * 100).toFixed(1) : ''} onChange={(e) => setIvInput(e.target.value)} className={inputClass} />
          </Field>
          <Field label={`Commissions, open + close · ${money(o.commission.per_contract, 2)}/contract`} htmlFor="risk-comm">
            <input id="risk-comm" type="number" step={0.01} value={commInput} placeholder={autoComm.toFixed(2)} onChange={(e) => setCommInput(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Account size, $" htmlFor="risk-nlv">
            <input id="risk-nlv" type="number" step={1} value={nlvInput} placeholder={o.account ? o.account.value.toFixed(0) : ''} onChange={(e) => setNlvInput(e.target.value)} className={inputClass} />
          </Field>
        </div>
      </section>

      {ready ? (
        <Scenario symbol={o.symbol} spot={spot} strike={strike} right={right} side={side} qty={qty} mult={o.multiplier}
          entry={entry} iv={iv} comm={comm} nlv={nlv} delta={quote?.delta ?? null} expiresAt={expiresAt} now={now}
          title={`${side === 'BUY' ? 'Long' : 'Short'} ${qty} ${o.symbol} ${expiryLabel(expiry, true)} ${strike % 1 ? strike.toFixed(2) : strike} ${right === 'C' ? 'call' : 'put'}${qty > 1 ? 's' : ''}`} />
      ) : (
        <div className="panel px-6 py-12 text-center text-[13px] text-ink-3" aria-busy={quoting}>
          {quoting || !strikes ? 'Reading the contract from TWS…' : 'This contract has no price or IV yet. Enter an entry price and IV above to see the heatmap.'}
        </div>
      )}
    </div>
  )
}

function Scenario({ symbol, spot, strike, right, side, qty, mult, entry, iv, comm, nlv, delta, expiresAt, now, title }: {
  symbol: string; spot: number; strike: number; right: Right; side: Side; qty: number; mult: number
  entry: number; iv: number; comm: number; nlv: number | null; delta: number | null; expiresAt: number; now: number; title: string
}) {
  const steps = useMemo(() => timeSteps(now, expiresAt), [now, expiresAt])
  const [step, setStep] = useState(0)
  const [hover, setHover] = useState<string | null>(null)
  const i = Math.min(step, steps.length - 1)
  const at = steps[i]
  const sign = side === 'BUY' ? 1 : -1

  const grid = useMemo(() => {
    const pos = { right, side, strike, spot, entry, iv, multiplier: mult, quantity: qty, commissions: comm, expiresAt }
    return VOL_STEPS.map((dv) => PRICE_STEPS.map((p) => scenarioPnl(pos, p, dv, at)))
  }, [right, side, strike, spot, entry, iv, mult, qty, comm, expiresAt, at])
  const scale = Math.max(1, ...grid.flat().map(Math.abs))

  const premium = entry * mult * qty
  const perShareComm = comm / (mult * qty)
  const breakeven = right === 'C' ? strike + entry + sign * perShareComm : strike - entry - sign * perShareComm
  const maxLoss = side === 'BUY' ? premium + comm : right === 'P' ? (strike - entry) * mult * qty + comm : null
  const shares = delta != null ? sign * delta * mult * qty : null
  const share = (v: number) => (nlv ? ` (${((v / nlv) * 100).toFixed(1)}% of account)` : '')

  const left = expiresAt - at
  const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }).format(at)
  const leftLabel = left <= 0 ? 'expiry' : left < 86_400_000 ? `${Math.floor(left / 3_600_000)}h ${String(Math.round((left % 3_600_000) / 60_000)).padStart(2, '0')}m left`
    : `${(left / 86_400_000).toFixed(1)} days left`

  return (
    <section className="panel space-y-4 p-5" aria-label="Scenario P&L">
      <Heading>{title}</Heading>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-md)] border border-line bg-line sm:grid-cols-4">
        <Cell label={side === 'BUY' ? 'Premium paid' : 'Premium received'} value={money(premium)} sub={nlv ? `${((premium / nlv) * 100).toFixed(1)}% of account` : undefined} />
        <Cell label="Max loss" value={maxLoss == null ? 'Unlimited' : money(maxLoss)} valueClass="text-neg"
          sub={maxLoss != null && nlv ? `${((maxLoss / nlv) * 100).toFixed(1)}% of account` : maxLoss == null ? 'short call' : undefined} />
        <Cell label="Breakeven at expiry" value={num(breakeven)} sub={`${num((breakeven / spot - 1) * 100, 1, true)}% from spot`} />
        <Cell label="Position delta" value={shares != null ? `${shares > 0 ? '+' : ''}${shares.toFixed(0)} sh` : '-'}
          sub={shares != null ? `${money(Math.abs(shares * spot))} of ${symbol}` : undefined} />
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="risk-time" className="text-xs text-ink-3">Time</label>
        <input id="risk-time" type="range" min={0} max={steps.length - 1} step={1} value={i} onChange={(e) => setStep(+e.target.value)}
          className="min-w-[160px] flex-1 accent-[var(--color-ink)]" />
        <span className="num w-64 text-right text-xs text-ink-2">{i === 0 ? 'Now' : when + ' ET'} · {leftLabel}</span>
      </div>

      <div className="overflow-x-auto">
        <table onMouseLeave={() => setHover(null)} className="w-full min-w-[1080px] table-fixed border-separate border-spacing-[2px] text-[12px]">
          <thead>
            <tr>
              <th scope="col" className="w-16 text-left text-[11px] font-normal text-ink-3">Vol / {symbol}</th>
              {PRICE_STEPS.map((p) => (
                <th key={p} scope="col" className="pb-1 font-normal text-ink-3">
                  <div className="num">{p > 0 ? '+' : ''}{p}%</div>
                  <div className="num text-[10.5px]">{(spot * (1 + p / 100)).toFixed(2)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {VOL_STEPS.map((dv, r) => (
              <tr key={dv}>
                <th scope="row" className="num text-left font-normal text-ink-3">
                  {dv > 0 ? '+' : ''}{dv}<span className="ml-1 text-[10.5px]">{Math.max(5, iv * 100 + dv).toFixed(0)}%</span>
                </th>
                {grid[r].map((v, c) => {
                  const t = Math.pow(Math.min(1, Math.abs(v) / scale), 0.7)
                  const tip = `${symbol} ${PRICE_STEPS[c] > 0 ? '+' : ''}${PRICE_STEPS[c]}% (${(spot * (1 + PRICE_STEPS[c] / 100)).toFixed(2)}), vol ${dv > 0 ? '+' : ''}${dv} pts, ${i === 0 ? 'now' : when + ' ET'}: ${signedMoney(v)}${share(v)}`
                  return (
                    <td key={c} onMouseEnter={() => setHover(tip)}
                      className={`num rounded-[3px] py-1.5 text-center ${t > 0.55 ? 'text-bg' : 'text-ink'} ${dv === 0 && PRICE_STEPS[c] === 0 ? 'outline outline-1 outline-ink-3' : 'hover:outline hover:outline-1 hover:outline-ink-3/60'}`}
                      style={{ background: `color-mix(in srgb, var(--color-${v >= 0 ? 'pos' : 'neg'}) ${Math.round(t * 85)}%, var(--color-surface-2))` }}>
                      {signedMoney(v)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="min-h-4 text-xs text-ink-2">{hover ?? 'Hover a cell for its share of the account.'}</p>
    </section>
  )
}

const SESSION_DOT: Record<MarketSession, { color: string; label: string }> = {
  regular: { color: 'var(--color-pos)', label: 'Market Open' },
  pre: { color: 'var(--color-warn)', label: 'Pre-Market' },
  post: { color: VOL_COLORS[0], label: 'After-hours' },  // the flow page's term-structure colour
  closed: { color: 'var(--color-ink-3)', label: 'Market Closed' },
}

function Dot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {htmlFor ? <label htmlFor={htmlFor} className="text-xs text-ink-3">{label}</label> : <span className="text-xs text-ink-3">{label}</span>}
      {children}
    </div>
  )
}

function Cell({ label, value, sub, valueClass = 'text-ink' }: { label: string; value: ReactNode; sub?: string; valueClass?: string }) {
  return (
    <div className="bg-surface px-3.5 py-3">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className={`num mt-1 text-[15px] ${valueClass}`}>{value}</dd>
      {sub && <dd className="mt-0.5 truncate text-[11px] text-ink-3">{sub}</dd>}
    </div>
  )
}
