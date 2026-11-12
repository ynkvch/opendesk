import type { Summary } from '../lib/api'
import { money, num, pct, rMult, signedMoney, tone } from '../lib/format'
import { Heading, Stat } from './ui'

export function StatsPanel({ s }: { s: Summary }) {
  return (
    <section className="panel flex flex-col p-5 md:p-6" aria-labelledby="perf-h">
      <Heading><span id="perf-h">Closed trades</span></Heading>

      <div className="mt-2">
        <p className={`num text-3xl tracking-[-0.03em] ${tone(s.net_pnl)}`}>{signedMoney(s.net_pnl)}</p>
        <p className="mt-1 text-sm text-ink-3">
          Net realized over <span className="num text-ink-2">{s.closed_trades}</span> trades,
          {' '}<span className="num text-ink-2">{s.open_trades}</span> open
        </p>
      </div>

      <dl className="mt-5 divide-y divide-line border-t border-line">
        <Stat label="Sharpe ratio" value={num(s.sharpe, 2)} />
        <Stat label="Profit factor" value={s.profit_factor == null && s.closed_trades > 0 && s.avg_loss == null ? '∞' : num(s.profit_factor, 2)}
          sub={s.profit_factor == null && s.closed_trades > 0 && s.avg_loss == null ? 'no losing trades' : undefined} />
        <Stat label="Max drawdown" value={pct(s.max_drawdown, 1)} valueClass={s.max_drawdown ? 'text-neg' : 'text-ink'} />
        <Stat label="Beta vs SPY" value={num(s.beta, 2)} />
        <Stat label="Alpha vs SPY" value={pct(s.alpha, 1, true)} valueClass={tone(s.alpha)} sub="annualized" />
        <Stat label="Average R" value={rMult(s.avg_r)} valueClass={tone(s.avg_r)} />
        <Stat label="Expectancy" value={signedMoney(s.expectancy)} valueClass={tone(s.expectancy)} sub="per trade" />
        <Stat label="Average MAE / MFE"
          value={<><span className="text-neg">{money(s.avg_mae)}</span><span className="text-ink-3"> / </span><span className="text-pos">{money(s.avg_mfe)}</span></>} />
      </dl>
      {s.sharpe == null && (
        <p className="mt-3 text-xs text-ink-3">Sharpe, drawdown, beta and alpha need 5 days of account history.</p>
      )}
    </section>
  )
}
