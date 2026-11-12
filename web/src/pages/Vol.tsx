import { ArrowsClockwise, CaretDown, CaretUp, Info, MagnifyingGlass } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { CurveChart, FlowBars, Legend, SeriesChart, SessionFlowChart, VOL_COLORS } from '../charts/VolCharts'
import { ExpandButton, ExpandOverlay, cardClass, useExpand } from '../components/Expand'
import { ErrorNote, Segmented, Skeleton } from '../components/ui'
import { ago, dateYear } from '../lib/format'
import { navigate } from '../lib/router'
import { expiryLabel, volApi, type FlowRow, type Vol } from '../lib/vol'

const MINUS = '−'
const ivFmt = (v: number) => `${(v * 100).toFixed(1)}%`
const ivAxis = (v: number) => `${(v * 100).toFixed(0)}`
const pts = (v: number) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(2)}`
const pctSigned = (v: number) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v * 100).toFixed(1)}%`
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const count = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 2)}M` : v >= 10_000 ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : intFmt.format(v))
function usd(v: number): string {
  const a = Math.abs(v)
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : a.toFixed(0)
  return `${v < 0 ? MINUS : ''}$${s}`
}
const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100) - 20 * Math.floor((n % 100) / 20) <= 3 && Math.floor((n % 100) / 10) !== 1 ? n % 10 : 0] ?? 'th'}`

type Range = '3M' | '6M' | '1Y'
const RANGE_DAYS: Record<Range, number> = { '3M': 92, '6M': 183, '1Y': 365 }

function since(pts: [string, number][], range: Range): [string, number][] {
  const from = new Date(Date.now() - RANGE_DAYS[range] * 86_400_000).toISOString().slice(0, 10)
  return pts.filter((p) => p[0] >= from)
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** a chart card in the same frame as the sector charts: title, the reading in one sentence, legend underneath. */
function Card({ title, reading, info, controls, legend, children, foot, tall = false }: {
  tall?: boolean
  title: string
  reading?: ReactNode
  info?: ReactNode
  controls?: ReactNode
  legend?: ReactNode
  children: ReactNode
  foot?: ReactNode
}) {
  const { ref, full, slot, toggle, close } = useExpand()
  const card = (
    <article ref={ref} role={full ? 'dialog' : undefined} aria-modal={full || undefined} aria-label={full ? title : undefined}
      className={full || !tall ? cardClass(full) : cardClass(full).replace('h-[450px]', 'h-[640px]')}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[17px] font-medium tracking-tight text-ink">{title}</h2>
            {info && (
              <div className="group relative inline-flex">
                <button type="button" aria-label={`How ${title} is read`} className="inline-flex text-ink-3 hover:text-ink-2"><Info size={15} /></button>
                <div role="tooltip"
                  className="invisible absolute left-0 top-6 z-20 w-[380px] max-w-[80vw] rounded-[var(--radius-md)] border border-line-strong bg-surface-2 p-3 text-[12px] leading-relaxed text-ink-2 opacity-0 shadow-xl transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                  {info}
                </div>
              </div>
            )}
          </div>
          {reading && <p className="mt-1 max-w-[62ch] text-[13px] leading-snug text-ink-2">{reading}</p>}
        </div>
        <div className="flex items-center gap-2">
          {controls}
          <ExpandButton full={full} onClick={toggle} />
        </div>
      </header>
      <div className={`mt-3 ${full ? 'h-[520px]' : 'min-h-0 flex-1'}`}>{children}</div>
      {legend && <div className="mt-2">{legend}</div>}
      {foot && <p className="mt-1 text-center text-[11px] text-ink-3">{foot}</p>}
    </article>
  )
  return <ExpandOverlay full={full} slot={slot} onClose={close}>{card}</ExpandOverlay>
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center rounded-[var(--radius-md)] border border-dashed border-line-strong px-6 text-center text-[13px] text-ink-3">
      <p className="max-w-[46ch]">{children}</p>
    </div>
  )
}

function Tile({ label, value, sub, tone = 'text-ink' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-[12px] text-ink-3">{label}</p>
      <p className={`num mt-1 text-[20px] tracking-tight ${tone}`}>{value}</p>
      {sub && <p className="num mt-0.5 text-[11px] text-ink-3">{sub}</p>}
    </div>
  )
}

// ---------- charts ----------

function IvRvCard({ v }: { v: Vol }) {
  const [range, setRange] = useState<Range>('1Y')
  const iv = useMemo(() => since(v.history.iv, range), [v, range])
  const rv = useMemo(() => since(v.history.rv, range), [v, range])
  const med = median(iv.map((p) => p[1]))
  const last = iv.at(-1)?.[1] ?? null
  const lastRv = rv.at(-1)?.[1] ?? null
  return (
    <Card title={`${v.symbol} implied vs realized volatility`}
      reading={last == null ? 'TWS returned no implied volatility history for this ticker.' : <>
        30-day implied is <span className="num text-ink">{ivFmt(last)}</span>
        {v.iv_percentile != null && <>, the <span className="num text-ink">{ordinal(Math.round(v.iv_percentile * 100))}</span> percentile of the past year</>}
        {lastRv != null && <>, <span className="num text-ink">{pts((last - lastRv) * 100)}</span> vol points over 30-day realized</>}.
      </>}
      info={<p>TWS's own 30-day implied volatility for the ticker (from its options) and 30-day historical volatility (from daily closes). Dashed line: the median implied over the range.</p>}
      controls={<Segmented<Range> label="Range" value={range} onChange={setRange} options={(['3M', '6M', '1Y'] as Range[]).map((r) => ({ value: r, label: r }))} />}
      legend={<Legend items={[
        { label: '30d implied', value: last != null ? ivFmt(last) : '-', color: VOL_COLORS[0] },
        { label: '30d realized', value: lastRv != null ? ivFmt(lastRv) : '-', color: VOL_COLORS[2] },
        ...(med != null ? [{ label: 'Median implied', value: ivFmt(med), color: 'rgb(255 255 255 / 0.7)', dashed: true }] : []),
      ]} />}>
      {iv.length > 1
        ? <SeriesChart series={[{ label: '30d implied', points: iv, color: VOL_COLORS[0] }, { label: '30d realized', points: rv, color: VOL_COLORS[2] }]}
            levels={med != null ? [{ value: med, label: 'Median' }] : []} format={ivAxis} ariaLabel={`${v.symbol} implied and realized volatility, ${range}`} />
        : <Empty>No volatility history from TWS for {v.symbol}.</Empty>}
    </Card>
  )
}

function SkewCard({ v }: { v: Vol }) {
  const t30 = v.skew.tenors[0]
  const put25 = t30?.values[2]
  const call25 = t30?.values[4]
  return (
    <Card title={`${v.symbol} skew structure`}
      reading={put25 != null && call25 != null ? <>
        At {t30.dte} days, 25Δ puts trade <span className="num text-ink">{Math.abs((put25 - call25) * 100).toFixed(2)}</span> vol points
        {put25 >= call25 ? ' over ' : ' under '}25Δ calls.
      </> : 'Not enough out-of-the-money quotes to read the skew.'}
      info={<p>Implied volatility at fixed deltas for the expiries nearest 30, 60 and 90 days, read from out-of-the-money options and interpolated between strikes. Higher on the left = puts cost more than calls.</p>}
      legend={<Legend items={v.skew.tenors.map((t, i) => ({ label: `${t.label} (${expiryLabel(t.expiry)})`, color: VOL_COLORS[i] }))} />}>
      <CurveChart categories={v.skew.buckets} format={ivAxis} ariaLabel={`${v.symbol} skew structure`}
        series={v.skew.tenors.map((t, i) => ({ label: t.label, color: VOL_COLORS[i], points: t.values.map((y, x) => [x, y] as [number, number | null]) }))} />
    </Card>
  )
}

function TermCard({ v }: { v: Vol }) {
  const a = v.atm['30']
  const b = v.atm['90']
  const shape = a != null && b != null ? (b > a ? 'Contango' : 'Backwardation') : null
  return (
    <Card title={`${v.symbol} term structure`}
      reading={shape ? <>
        {shape}: 30-day at-the-money implied <span className="num text-ink">{ivFmt(a!)}</span> against
        {' '}<span className="num text-ink">{ivFmt(b!)}</span> at 90 days, {pts((b! - a!) * 100)} vol points.
      </> : 'Not enough expiries to read the curve.'}
      info={<p>At-the-money implied volatility for each expiry out to about a year. Past curves come from this dashboard's daily snapshots, so they appear once it has a snapshot from that far back.</p>}
      legend={<Legend items={[{ label: 'Now', color: VOL_COLORS[0] }, ...v.term_past.map((p, i) => ({ label: `${p.label} (${dateYear(p.date)})`, color: VOL_COLORS[i + 1] }))]} />}
      foot={v.term_past.length ? undefined : `Past curves appear once snapshots reach back a week (stored since ${v.stored.since ? dateYear(v.stored.since) : 'today'}).`}>
      <CurveChart format={ivAxis} xFormat={(d) => `${d}d`} ariaLabel={`${v.symbol} term structure`}
        series={[
          { label: 'Now', color: VOL_COLORS[0], points: v.term.map((t) => [t.dte, t.iv] as [number, number]) },
          ...v.term_past.map((p, i) => ({ label: p.label, color: VOL_COLORS[i + 1], points: p.term.map((t) => [t.dte, t.iv] as [number, number]) })),
        ]} />
    </Card>
  )
}

function ForwardCard({ v }: { v: Vol }) {
  const f = v.forward_factor
  const hist = v.stored.forward_factor
  const med = median(hist.map((p) => p[1]))
  const pct = f.value != null && hist.length > 4 ? Math.round((hist.filter((p) => p[1] < f.value!).length / hist.length) * 100) : null
  return (
    <Card title={`${v.symbol} 30-60d forward factor`}
      reading={f.value == null ? 'Needs expiries either side of 30 and 60 days.' : <>
        The 30-day option is priced <span className="num text-ink">{Math.abs(f.value * 100).toFixed(0)}%</span>
        {f.value < 0 ? ' below ' : ' above '}the 30-60 day window{pct != null && <>, the {ordinal(pct)} percentile of {hist.length} days stored</>}.
        {' '}30-day implied is <span className="num text-ink">{ivFmt(f.iv30!)}</span> against <span className="num text-ink">{ivFmt(f.forward!)}</span> forward.
      </>}
      info={<p>Forward vol for days 30 to 60 comes from the 30- and 60-day at-the-money vols: √((σ60²·60 − σ30²·30) / 30). The factor is σ30 ÷ forward − 1: negative = the near month is cheap against the next. History builds from this dashboard's daily snapshots.</p>}
      legend={<Legend items={[
        { label: '30-60d forward factor', value: f.value != null ? pctSigned(f.value) : '-', color: VOL_COLORS[0] },
        ...(med != null ? [{ label: 'Median', value: pctSigned(med), color: 'rgb(255 255 255 / 0.7)', dashed: true }] : []),
      ]} />}>
      {hist.length > 1
        ? <SeriesChart series={[{ label: 'Forward factor', points: hist, color: VOL_COLORS[0] }]} levels={med != null ? [{ value: med, label: 'Median' }] : []}
            format={(x) => `${(x * 100).toFixed(0)}`} ariaLabel={`${v.symbol} forward factor history`} />
        : <Empty>History starts {v.stored.since ? dateYear(v.stored.since) : 'today'}. One point is stored a day, each time {v.symbol} is loaded and from the daily job.</Empty>}
    </Card>
  )
}

function Skew25Card({ v }: { v: Vol }) {
  const hist = v.stored.skew25
  const s = v.skew25
  return (
    <Card title={`${v.symbol} 25-delta skew`}
      reading={s == null ? 'Not enough quotes at 25 delta.' : <>Call IV minus put IV at 30 days. {s < 0 ? 'Puts' : 'Calls'} bid at <span className="num text-ink">{pts(s)}</span>.</>}
      info={<p>25-delta call implied vol minus 25-delta put implied vol, in vol points, for the expiry nearest 30 days. Below zero (red) = puts are bid. History builds from this dashboard's daily snapshots.</p>}
      legend={<Legend items={[{ label: 'Calls bid', color: 'var(--color-pos)' }, { label: 'Puts bid', color: 'var(--color-neg)' }]} />}>
      {hist.length > 1
        ? <SeriesChart series={[{ label: '25Δ skew', points: hist, color: VOL_COLORS[0] }]} zeroFill format={(x) => x.toFixed(0)} ariaLabel={`${v.symbol} 25-delta skew history`} />
        : <Empty>History starts {v.stored.since ? dateYear(v.stored.since) : 'today'}. One point is stored a day, each time {v.symbol} is loaded and from the daily job.</Empty>}
    </Card>
  )
}

// ---------- flow ----------

type Metric = 'volume' | 'premium' | 'oi'
type SortKey = 'traded' | 'expiry' | 'strike' | 'volume' | 'prev' | 'new' | 'oi' | 'ratio' | 'premium' | 'iv' | 'delta'
const TOP = 5
const METRICS: { value: Metric; label: string }[] = [{ value: 'volume', label: 'Volume' }, { value: 'premium', label: 'Premium' }, { value: 'oi', label: 'Open interest' }]

function Flow({ v }: { v: Vol }) {
  const f = v.flow
  const traded = f.rows.some((r) => r.volume > 0)
  const [metric, setMetric] = useState<Metric>(traded ? 'volume' : 'oi')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'traded', dir: -1 })
  const [all, setAll] = useState(false)
  // a new ticker starts on volume, or open interest before anything trades
  useEffect(() => {
    setMetric(f.rows.some((r) => r.volume > 0) ? 'volume' : 'oi')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.symbol])

  const rows = f.rows

  const byStrike = useMemo(() => {
    const m = new Map<number, { strike: number; calls: number; puts: number }>()
    for (const r of rows) {
      const x = m.get(r.strike) ?? { strike: r.strike, calls: 0, puts: 0 }
      const val = metric === 'volume' ? r.volume : metric === 'premium' ? r.premium : r.oi ?? 0
      if (r.right === 'C') x.calls += val
      else x.puts += val
      m.set(r.strike, x)
    }
    return [...m.values()].sort((a, b) => a.strike - b.strike)
  }, [rows, metric])

  const value = (r: FlowRow, k: SortKey): number => k === 'expiry' ? Number(r.expiry) : k === 'ratio' ? (r.oi ? r.volume / r.oi : Infinity)
    : k === 'new' ? r.new ?? -1 : k === 'prev' ? r.prev_volume ?? -1 : (r[k as keyof FlowRow] as number | null) ?? -Infinity
  // most traded first: today's volume, then the last session's, then open interest
  const byTraded = (a: FlowRow, b: FlowRow) => (a.volume - b.volume) || ((a.prev_volume ?? 0) - (b.prev_volume ?? 0)) || ((a.oi ?? 0) - (b.oi ?? 0))
  const sorted = useMemo(() => [...rows].sort((a, b) =>
    (sort.key === 'traded' ? byTraded(a, b) : value(a, sort.key) - value(b, sort.key)) * sort.dir || byTraded(b, a)), [rows, sort])
  const shown = all ? sorted : sorted.slice(0, TOP)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
  const fmtMetric = metric === 'premium' ? usd : count

  const points = v.flow_points
  const th = (k: SortKey | null, label: string, cls = 'text-right') => (
    <th scope="col" className={`h-9 px-3 font-normal ${cls}`} aria-sort={k && sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
      {k ? (
        <button type="button" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : -1 }))}
          className={`inline-flex items-center gap-1 hover:text-ink-2 ${sort.key === k ? 'text-ink-2' : ''}`}>
          {label}{sort.key === k && (sort.dir === 1 ? <CaretUp size={10} weight="bold" /> : <CaretDown size={10} weight="bold" />)}
        </button>
      ) : label}
    </th>
  )

  return (
    <section aria-labelledby="flow-h" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="flow-h" className="text-[17px] font-medium tracking-tight">{v.symbol} options flow</h2>
          <p className="mt-1 max-w-[80ch] text-[13px] text-ink-2">
            Today, across every contract read so far: calls <span className="num text-pos">{usd(f.call_premium)}</span> on {count(f.call_volume)} contracts,
            puts <span className="num text-neg">{usd(f.put_premium)}</span> on {count(f.put_volume)}.
            {' '}<span className="whitespace-nowrap">Put/call premium <span className="num text-ink">{f.call_premium ? (f.put_premium / f.call_premium).toFixed(2) : '-'}</span>.</span>
          </p>
        </div>
      </div>


      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title={`${v.symbol} flow by strike`}
          controls={<Segmented<Metric> label="Measure" value={metric} onChange={setMetric} options={METRICS} />}
          legend={<Legend items={[{ label: 'Calls', value: fmtMetric(byStrike.reduce((t, r) => t + r.calls, 0)), color: 'var(--color-pos)' },
            { label: 'Puts', value: fmtMetric(byStrike.reduce((t, r) => t + r.puts, 0)), color: 'var(--color-neg)' }]} />}>
          {byStrike.some((r) => r.calls || r.puts)
            ? <FlowBars rows={byStrike} spot={v.spot} format={fmtMetric} ariaLabel={`${v.symbol} ${metric} by strike`} storageKey={`flow.strikes.${v.symbol}`} />
            : <Empty>{byStrike.length ? `No ${METRICS.find((m) => m.value === metric)!.label.toLowerCase()} yet today.` : 'No contracts read yet.'}</Empty>}
        </Card>
        <Card title={`${v.symbol} premium through the day`}
          legend={<Legend items={[{ label: 'Call premium', value: usd(f.call_premium), color: 'var(--color-pos)' }, { label: 'Put premium', value: usd(f.put_premium), color: 'var(--color-neg)' }]} />}>
          {points.length > 1 && points.some((p) => p.call_premium || p.put_premium)
            ? <SeriesChart time format={(x) => usd(x)} ariaLabel={`${v.symbol} call and put premium today`}
                series={[{ label: 'Calls', color: 'var(--color-pos)', points: points.map((p) => [p.time, p.call_premium] as [string, number]) },
                  { label: 'Puts', color: 'var(--color-neg)', points: points.map((p) => [p.time, p.put_premium] as [string, number]) }]} />
            : <Empty>{traded ? 'One reading so far today; a point is added every minute.' : 'No premium traded yet today. It fills in from 09:30 New York, a point every minute.'}</Empty>}
        </Card>
      </div>

      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[1080px] border-collapse text-[13px]">
          <thead className="text-left text-xs text-ink-3">
            <tr className="border-b border-line">
              {th('expiry', 'Expiry', 'pl-4 text-left')}
              {th('strike', 'Strike')}
              {th(null, 'Type', 'text-left')}
              {th('volume', 'Volume')}
              {th('prev', f.prev_day ? `Volume ${expiryLabel(f.prev_day.replaceAll('-', ''))}` : 'Last session')}
              {th('new', 'New')}
              {th('oi', 'Open int.')}
              {th('ratio', 'Vol / OI')}
              {th('premium', 'Premium')}
              {th(null, 'Bid / ask')}
              {th(null, 'Last')}
              {th(null, 'Side', 'text-left')}
              {th('iv', 'IV')}
              {th('delta', 'Delta', 'pr-4 text-right')}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const big = r.oi != null && r.volume > r.oi
              return (
                <tr key={`${r.expiry}${r.strike}${r.right}`} className="h-10 border-b border-line last:border-b-0 hover:bg-surface-2">
                  <td className="num pl-4 pr-3 text-ink-2">{expiryLabel(r.expiry)} <span className="text-ink-3">{r.dte}d</span></td>
                  <td className="num px-3 text-right text-ink">{r.strike}</td>
                  <td className={`px-3 font-medium ${r.right === 'C' ? 'text-pos' : 'text-neg'}`}>{r.right === 'C' ? 'Call' : 'Put'}</td>
                  <td className="num px-3 text-right text-ink">{intFmt.format(r.volume)}</td>
                  <td className="num px-3 text-right text-ink-2">{r.prev_volume == null ? '-' : intFmt.format(r.prev_volume)}</td>
                  <td className={`num px-3 text-right ${r.new ? 'text-ink' : 'text-ink-3'}`}>{r.new == null ? '-' : r.new ? `+${intFmt.format(r.new)}` : '0'}</td>
                  <td className="num px-3 text-right text-ink-2" title={r.oi_date && r.oi_date !== today ? `Last sent by TWS on ${r.oi_date}` : undefined}>
                    {r.oi == null ? '-' : intFmt.format(r.oi)}{r.oi_date && r.oi_date !== today && <span className="text-ink-3">*</span>}
                  </td>
                  <td className={`num px-3 text-right ${big ? 'text-warn' : 'text-ink-2'}`}>{r.oi ? (r.volume / r.oi).toFixed(2) : '-'}</td>
                  <td className="num px-3 text-right text-ink">{usd(r.premium)}</td>
                  <td className="num px-3 text-right text-ink-3">{r.bid?.toFixed(2) ?? '-'} / {r.ask?.toFixed(2) ?? '-'}</td>
                  <td className="num px-3 text-right text-ink-2">{r.last?.toFixed(2) ?? '-'}</td>
                  <td className="px-3 text-ink-3">{r.side === 'ask' ? 'At ask' : r.side === 'bid' ? 'At bid' : r.side === 'mid' ? 'Mid' : '-'}</td>
                  <td className="num px-3 text-right text-ink-2">{r.iv != null ? ivFmt(r.iv) : '-'}</td>
                  <td className="num pr-4 pl-3 text-right text-ink-2">{r.delta != null ? r.delta.toFixed(2) : '-'}</td>
                </tr>
              )
            })}
            {!shown.length && <tr><td colSpan={14} className="px-4 py-12 text-center text-sm text-ink-3">No contracts match these filters.</td></tr>}
          </tbody>
        </table>
        {sorted.length > TOP && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[12px] text-ink-3">
            <span>{all ? `All ${sorted.length} contracts` : `Top ${TOP} of ${sorted.length} contracts`}, most traded first.{rows.some((r) => r.oi_date && r.oi_date !== today) ? ' * = open interest TWS last sent on an earlier day.' : ''}</span>
            <button type="button" onClick={() => setAll((x) => !x)}
              className="h-7 rounded-[var(--radius-md)] border border-line-strong px-3 text-[12px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
              {all ? `Show top ${TOP}` : `See all ${sorted.length}`}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

function Sessions({ v }: { v: Vol }) {
  const s = v.sessions
  const [metric, setMetric] = useState<'volume' | 'premium'>('premium')
  const [step, setStep] = useState<Step>('5m')
  // the server sends 5-minute bars; 15 and 30 minutes are added up from them, within each session
  const bars = useMemo(() => {
    const size = STEP_MIN[step]
    const out: { time: string; day: string; price: number; calls: number; puts: number }[] = []
    for (const b of s.bars) {
      const t = new Date(b.time)
      const mins = t.getUTCHours() * 60 + t.getUTCMinutes()
      const key = `${b.day}|${Math.floor(mins / size)}`
      const calls = metric === 'volume' ? b.call_volume : b.call_premium
      const puts = metric === 'volume' ? b.put_volume : b.put_premium
      const last = out[out.length - 1]
      if (last && `${last.day}|${Math.floor((new Date(last.time).getUTCHours() * 60 + new Date(last.time).getUTCMinutes()) / size)}` === key) {
        last.calls += calls
        last.puts += puts
        last.price = b.price  // the bar's close is its last 5 minutes' close
      } else out.push({ time: b.time, day: b.day, price: b.price, calls, puts })
    }
    return out
  }, [s.bars, metric, step])
  const fmt = metric === 'premium' ? usd : count
  const calls = s.days.reduce((t, d) => t + (metric === 'volume' ? d.call_volume : d.call_premium), 0)
  const puts = s.days.reduce((t, d) => t + (metric === 'volume' ? d.put_volume : d.put_premium), 0)
  const first = s.days[0]?.close
  const last = s.days.at(-1)?.close
  return (
    <div className="space-y-3">
      <Card tall title={`${v.symbol} flow`}
        reading={s.days.length ? <>
          Over {s.days.length} past {s.days.length === 1 ? 'session' : 'sessions'}: calls <span className="num text-pos">{fmt(calls)}</span>,
          puts <span className="num text-neg">{fmt(puts)}</span>{first && last ? <>, while {v.symbol} moved <span className="num text-ink">{pctSigned(last / first - 1)}</span></> : null}.
        </> : 'Reading each contract\'s trade history from TWS.'}
        info={<><p>TWS's 5-minute trade bars for every option that has traded, summed into calls and puts; 15 and 30 minutes are added up from them. Premium is each bar's volume × its volume-weighted average price × 100. The bars come from IBKR's servers whenever TWS is open, so missed sessions are filled in later (up to five back); options that expired while TWS was closed can't be. Today's bars refresh every 20 minutes in market hours.</p>
          <p className="mt-2">{s.building ? `Updating from TWS: ${s.done} of ${s.total} contracts read.` : s.error ? `Last update failed: ${s.error}` : `Built from ${s.contracts} different options (each strike, expiry and type counted once).`}</p>
          <p className="mt-2">Each line is call and put {metric} every {STEP_MIN[step]} minutes, smoothed over about {STEP_MIN[step] * STEP_SPAN[step]} minutes; the white line is the share price.</p></>}
        controls={<>
          <Segmented<Step> label="Interval" value={step} onChange={setStep}
            options={(['5m', '15m', '30m'] as Step[]).map((x) => ({ value: x, label: x }))} />
          <Segmented<'volume' | 'premium'> label="Measure" value={metric} onChange={setMetric}
            options={[{ value: 'premium', label: 'Premium' }, { value: 'volume', label: 'Volume' }]} />
        </>}
        legend={<Legend items={[{ label: 'Calls', value: fmt(calls), color: 'var(--color-pos)' }, { label: 'Puts', value: fmt(puts), color: 'var(--color-neg)' },
          { label: `${v.symbol} price`, value: last?.toFixed(2), color: '#ececea' }]} />}>
        {bars.length
          ? <SessionFlowChart bars={bars} span={STEP_SPAN[step]} format={fmt} priceFormat={(x) => x.toFixed(2)} ariaLabel={`${v.symbol} call and put ${metric} over the past sessions`} />
          : <Empty>{s.building ? `Reading each contract's 5-minute trade history from TWS: ${s.done} of ${s.total}. The first time takes a few minutes.` : s.error ? `Couldn't read the trade history: ${s.error}` : 'Starts reading the trade history within a few seconds.'}</Empty>}
      </Card>
    </div>
  )
}

type Step = '5m' | '15m' | '30m'
const STEP_MIN: Record<Step, number> = { '5m': 5, '15m': 15, '30m': 30 }
// how many bars each point averages: about 35 minutes at 5m, 45 at 15m, 90 at 30m
const STEP_SPAN: Record<Step, number> = { '5m': 7, '15m': 3, '30m': 3 }

// ---------- page ----------

const LAST_TICKER = 'flow.lastTicker'

export function VolPage({ path }: { path: string }) {
  const symbol = decodeURIComponent(path.split('/')[2] ?? '').toUpperCase()
  const [data, setData] = useState<Vol | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<string>('tws')
  const [input, setInput] = useState('')
  const [live, setLive] = useState(true)
  const [, setTick] = useState(0)

  const refreshList = useCallback(() => { volApi.watchlist().then((w) => setMode(w.source)).catch(() => {}) }, [])

  // the tab reopens on the last ticker: remembered in this browser, else the one the server saw last
  useEffect(() => {
    if (symbol) {
      try { localStorage.setItem(LAST_TICKER, symbol) } catch { /* storage blocked: the server's list still works */ }
      return
    }
    let last: string | null = null
    try { last = localStorage.getItem(LAST_TICKER) } catch { /* fall through to the server */ }
    if (last) {
      navigate(`/flow/${encodeURIComponent(last)}`, { replace: true })
      return
    }
    volApi.watchlist().then((w) => {
      const recent = w.watchlist[0]?.symbol
      if (recent) navigate(`/flow/${encodeURIComponent(recent)}`, { replace: true })
    }).catch(() => {})
  }, [symbol])
  const load = useCallback((refresh: boolean) => {
    if (!symbol) return
    setLoading(true)
    setError(null)
    volApi.get(symbol, { refresh, live })
      .then((d) => { setData(d); refreshList() })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, refreshList])

  useEffect(refreshList, [refreshList])
  useEffect(() => { setData((d) => (d?.symbol === symbol ? d : null)); load(false) }, [symbol, load])
  // live: the server reads tws every minute while this page asks; the page checks every 10 s and redraws only when
  // a new reading or new history has arrived
  useEffect(() => {
    if (!live || !symbol) return
    const id = window.setInterval(() => {
      setTick((t) => t + 1)
      if (document.hidden) return
      volApi.get(symbol, { live: true })
        .then((d) => { setError(null); setData((prev) => (prev && prev.symbol === d.symbol && prev.version === d.version ? prev : d)) })
        .catch((e: Error) => setError(e.message))
    }, 10_000)
    return () => window.clearInterval(id)
  }, [live, symbol])

  function submit(e: FormEvent) {
    e.preventDefault()
    const s = input.trim().toUpperCase()
    if (s) navigate(`/flow/${encodeURIComponent(s)}`)
    setInput('')
  }

  const v = data?.symbol === symbol ? data : null
  const change = v?.prev_close ? v.spot / v.prev_close - 1 : null
  const sourceLabel = v?.source === 'simulated' ? 'Simulated data' : v?.source === 'delayed' ? 'TWS, delayed' : 'TWS'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">Flow</h1>
          <form onSubmit={submit} className="flex items-center gap-2" role="search">
            <label className="relative">
              <span className="sr-only">Ticker</span>
              <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ticker, e.g. NVDA" autoCapitalize="characters" spellCheck={false}
                className="h-8 w-44 rounded-[var(--radius-md)] border border-line bg-bg pl-8 pr-2 text-[13px] uppercase text-ink placeholder:normal-case placeholder:text-ink-3 outline-none focus:border-line-strong" />
            </label>
            <button type="submit" className="h-8 rounded-[var(--radius-md)] border border-line-strong px-3 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink active:translate-y-px">Load</button>
          </form>
          {symbol && (
            <span className="num inline-flex h-8 items-center rounded-[var(--radius-md)] border border-line-strong bg-surface-3 px-2.5 text-[12px] text-ink">{symbol}</span>
          )}
        </div>
        {symbol && (
          <div className="flex items-center gap-3 text-xs text-ink-3">
            {v && (
              <span className="inline-flex items-center gap-1.5" title={`Read in ${v.seconds}s`}>
                <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${v.source === 'live' ? 'bg-pos' : 'bg-warn'}`} />
                {sourceLabel} · read <span className="num text-ink-2">{ago(v.as_of)}</span>
                {v.live.error && <span className="text-neg" title={v.live.error}> · last read failed</span>}
              </span>
            )}
            <label className="inline-flex items-center gap-1.5 text-ink-2" title="Reads TWS every minute while this page is open, and redraws when new data arrives">
              <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} className="accent-[var(--color-ink)]" />
              Live, every minute
            </label>
            <button type="button" onClick={() => load(true)} disabled={loading} aria-busy={loading}
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-line-strong px-3 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink active:translate-y-px disabled:cursor-wait disabled:opacity-60">
              <ArrowsClockwise size={13} className={loading ? 'animate-spin' : ''} />{loading ? 'Reading TWS…' : 'Reload'}
            </button>
          </div>
        )}
      </div>

      {!symbol && (
        <div className="panel px-6 py-16 text-center">
          <p className="text-[15px] text-ink">Pick a ticker to read its options from TWS.</p>
          <p className="mx-auto mt-2 max-w-[60ch] text-[13px] text-ink-3">
            Implied against realized volatility, the skew at 30, 60 and 90 days, the term structure, the forward factor and today's flow by strike.
            {mode === 'sim' ? ' Running on simulated data (VOL_SOURCE=sim).' : ' TWS must be open with the API enabled on port 7496.'}
          </p>
        </div>
      )}
      {symbol && error && <ErrorNote message={error} onRetry={() => load(true)} />}
      {symbol && !v && !error && (
        <div className="space-y-4" aria-busy="true" aria-label="Loading">
          <p className="text-[13px] text-ink-3">Reading {symbol}'s option chain from TWS. A ticker's first load takes about a minute; after that, about 40 seconds.</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[76px]" />)}</div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[450px]" />)}</div>
        </div>
      )}

      {v && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Tile label={`${v.symbol} spot`} value={v.spot.toFixed(2)} sub={change != null ? pctSigned(change) + ' today' : undefined}
              tone={change != null && change < 0 ? 'text-neg' : 'text-ink'} />
            <Tile label="30d implied" value={v.iv30 != null ? ivFmt(v.iv30) : '-'} sub="TWS index" />
            <Tile label="IV rank, 1 year" value={v.iv_rank != null ? (v.iv_rank * 100).toFixed(0) : '-'} sub="0 = low, 100 = high" />
            <Tile label="IV percentile, 1 year" value={v.iv_percentile != null ? ordinal(Math.round(v.iv_percentile * 100)) : '-'} sub="days below today" />
            <Tile label="30d realized" value={v.rv30 != null ? ivFmt(v.rv30) : '-'} sub={v.iv30 != null && v.rv30 != null ? `IV − RV ${pts((v.iv30 - v.rv30) * 100)}` : undefined} />
          </div>

          <Sessions v={v} />

          <Flow v={v} />

          <section aria-labelledby="vol-h" className="space-y-4">
            <h2 id="vol-h" className="text-[17px] font-medium tracking-tight">{v.symbol} volatility</h2>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <IvRvCard v={v} />
              <SkewCard v={v} />
              <TermCard v={v} />
              <ForwardCard v={v} />
              <Skew25Card v={v} />
            </div>
          </section>
        </>
      )}
    </div>
  )
}
