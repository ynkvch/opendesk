import type { Costs, Fees } from '../lib/api'
import { dateYear, money, pct } from '../lib/format'
import { Heading } from './ui'

const paid = (v: number) => (Math.abs(v) < 0.005 ? money(0, 2) : `−${money(v, 2)}`)
const monthLabel = (m: string) =>
  new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' }).format(new Date(`${m}-01T12:00:00Z`))

/** Every cost of trading: commissions by asset class, market data, other fees and interest. */
export function CostsPanel({ costs, fees }: { costs: Costs; fees: Fees }) {
  const users = new Map<string, { total: number; items: { name: string; amount: number }[] }>()
  for (const s of costs.subscriptions) {
    const [user, ...rest] = s.description.split(':')
    const name = rest.join(':').replace(/ FOR [A-Z]{3} \d{4}$/, '').trim() || s.description
    const u = users.get(user) ?? { total: 0, items: [] }
    u.total += s.amount
    u.items.push({ name, amount: s.amount })
    users.set(user, u)
  }

  return (
    <section className="panel p-5 md:p-6" aria-labelledby="costs-h">
      <Heading><span id="costs-h">Costs</span></Heading>

      {costs.from && (
        <p className="mt-4 text-sm text-ink-2">
          Total paid since <span className="num text-ink">{dateYear(costs.from)}</span>
        </p>
      )}
      <p className="num mt-1 text-3xl tracking-[-0.03em] text-neg">{paid(costs.total)}</p>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)]">
        <div>
          <h3 className="text-xs text-ink-3">By type</h3>
          <table className="mt-2 w-full text-[13px]">
            <thead className="text-xs text-ink-3">
              <tr className="h-8 border-b border-line text-right">
                <th scope="col" className="text-left font-normal">Type</th>
                <th scope="col" className="font-normal">Paid</th>
              </tr>
            </thead>
            <tbody className="num">
              {[
                ['Option commissions', costs.by_asset.OPT ?? 0, fees.per_contract == null ? null : `${money(fees.per_contract, 2)} per contract`],
                ['Stock commissions', costs.by_asset.STK ?? 0, null],
                ['Currency conversion', costs.by_asset.CASH ?? 0, null],
                ['Market data', costs.market_data, null],
                ['Other fees', costs.other_fees, null],
                ['Interest paid', costs.interest, null],
              ].map(([label, value, sub]) => (
                <tr key={label as string} className="h-9 border-b border-line text-right last:border-b-0">
                  <th scope="row" className="text-left font-sans font-normal text-ink-2">{label}</th>
                  <td>
                    {sub && <span className="mr-2 text-xs text-ink-3">{sub}</span>}
                    <span className={(value as number) > 0.005 ? 'text-neg' : 'text-ink-3'}>{paid(value as number)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {fees.pct_of_premium != null && (
            <p className="mt-3 text-xs text-ink-3">
              Option commissions are <span className="num text-ink-2">{pct(fees.pct_of_premium, 1)}</span> of the
              premium you paid ({money(fees.premium, 2)}).
            </p>
          )}
        </div>

        <div>
          <h3 className="text-xs text-ink-3">By month</h3>
          <table className="mt-2 w-full text-[13px]">
            <thead className="text-xs text-ink-3">
              <tr className="h-8 border-b border-line text-right">
                <th scope="col" className="text-left font-normal">Month</th>
                <th scope="col" className="font-normal">Commissions</th>
                <th scope="col" className="font-normal">Data</th>
                <th scope="col" className="font-normal">Other</th>
                <th scope="col" className="font-normal">Total</th>
              </tr>
            </thead>
            <tbody className="num">
              {[...costs.by_month].reverse().map((m) => {
                const other = m.other_fees + m.interest
                return (
                  <tr key={m.month} className="h-9 border-b border-line text-right text-ink-2 last:border-b-0">
                    <th scope="row" className="text-left font-sans font-normal text-ink-2">{monthLabel(m.month)}</th>
                    <td>{money(m.commissions, 2)}</td>
                    <td>{money(m.market_data, 2)}</td>
                    <td>{money(other, 2)}</td>
                    <td className="text-ink">{money(m.commissions + m.market_data + other, 2)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="text-xs text-ink-3">
            Market data billed{costs.subscriptions_month && ` for ${monthLabel(costs.subscriptions_month)}`}
          </h3>
          {users.size === 0 ? (
            <p className="mt-2 text-sm text-ink-3">No subscriptions billed.</p>
          ) : (
            <div className="mt-2 space-y-3">
              {[...users.entries()].map(([user, u]) => (
                <div key={user} className="rounded-[var(--radius-sm)] bg-surface-2 px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="code text-ink-2">{user}</span>
                    <span className="num text-neg">{paid(u.total)} / month</span>
                  </div>
                  <ul className="mt-1.5 space-y-0.5 text-xs text-ink-3">
                    {u.items.map((it) => (
                      <li key={it.name} className="flex justify-between gap-3">
                        <span className="truncate">{it.name}</span>
                        <span className="num">{money(it.amount, 2)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {users.size > 1 && (
                <p className="text-xs text-ink-3">Billed per username: each login with data subscriptions pays separately.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
