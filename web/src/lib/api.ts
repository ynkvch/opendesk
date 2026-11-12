export type TradeRow = {
  id: number
  underlying: string
  strategy: string
  bias: 'bullish' | 'bearish' | 'neutral' | 'volatility'
  status: 'open' | 'closed'
  quantity: number
  opened_at: string
  closed_at: string | null
  entry_price: number
  exit_price: number | null
  max_risk: number
  mae: number
  mfe: number
  iv_entry: number
  iv_rank_entry: number | null
  dte_entry: number
  delta_entry: number
  theta_entry: number
  source: string
  contract: string
  leg_types: string[]
  commissions: number
  asset: 'OPT' | 'STK'
  multiplier: number
  /** 1 when the position was bought before the earliest statement, so opened_at is only a bound */
  open_estimated: number
  pnl: number | null
  r_multiple: number | null
  hold_hours: number | null
  has_thesis: boolean
}

export type Leg = {
  id: number
  side: 'BUY' | 'SELL'
  right_: 'C' | 'P' | 'S'
  strike: number
  expiry: string
  entry_price: number
  exit_price: number | null
  iv_entry: number
  iv_exit: number | null
  delta_entry: number
  delta_exit: number | null
}

export type Fill = {
  id: number
  time: string
  action: 'OPEN' | 'CLOSE'
  side: 'BOT' | 'SLD'
  description: string
  quantity: number
  price: number
  commission: number
}

export type Mark = { time: string; underlying: number; pnl: number }

export type TradeRisk = {
  nlv_at_entry: number | null // account value on the day the trade opened
  capital: number | null // the most the position can lose; null when unlimited
  capital_pct: number | null // as a share of the account at entry
  sharpe: number | null // over the holding period, not annualised
  sharpe_steps: number
  sharpe_every: '5 minutes' | 'hour' // the price path it was measured on
}

export type TradeDetail = TradeRow & {
  risk: TradeRisk
  realized_pnl: number | null
  und_entry: number
  und_exit: number | null
  und_high: number
  und_low: number
  pos_high: number
  pos_low: number
  iv_exit: number | null
  und_last: number | null
  iv_last: number | null
  last_update: string | null
  /** IBKR's model valuation taken outside the options session: option price, P&L, underlying, time */
  model_mark: number | null
  model_pnl: number | null
  model_und: number | null
  model_at: string | null
  hv20_entry: number | null
  gamma_entry: number
  vega_entry: number
  delta_exit: number | null
  gamma_exit: number | null
  theta_exit: number | null
  vega_exit: number | null
  thesis: string
  post_mortem: string
  legs: Leg[]
  fills: Fill[]
  marks: Mark[]
}

export type Group = { name: string; trades: number; pnl: number; win_rate: number }

export type Fees = {
  total: number
  fills: number
  contracts: number
  per_contract: number | null
  premium: number
  pct_of_premium: number | null
  pct_of_gross_wins: number | null
}

export type Summary = {
  as_of: string | null
  fees: Fees
  closed_trades: number
  open_trades: number
  net_pnl: number
  win_rate: number | null
  avg_win: number | null
  avg_loss: number | null
  profit_factor: number | null
  expectancy: number | null
  avg_r: number | null
  avg_hold_hours: number | null
  avg_mae: number | null
  avg_mfe: number | null
  mfe_capture: number | null
  commissions: number
  // from daily account values, deposits and withdrawals taken out; null with under 20 daily returns
  sharpe: number | null
  max_drawdown: number | null
  beta: number | null
  alpha: number | null
  risk_free: number | null
  return_days: number
  by_strategy: Group[]
  by_underlying: Group[]
}

export type AccountDay = {
  date: string
  net_liquidation: number
  realized_pnl: number
  unrealized_pnl: number
  spy: number | null
}

export type CostMonth = { month: string; commissions: number; market_data: number; other_fees: number; interest: number }

export type Costs = {
  from: string | null
  to: string | null
  total: number
  commissions: number
  by_asset: Record<string, number>
  market_data: number
  other_fees: number
  interest: number
  by_month: CostMonth[]
  subscriptions_month: string | null
  subscriptions: { description: string; amount: number }[]
}

export type ThetaClose = {
  date: string
  underlying: number
  option: number
  iv: number | null
  /** position extrinsic value at the close, USD */
  extrinsic: number
  /** position theta at the close, USD per calendar day */
  theta: number | null
}

export type ThetaDay = { date: string; extrinsic: number; decay: number }

export type Theta =
  | { available: false; reason: string }
  | {
      available: true
      expiry: string
      strike: number
      right: 'C' | 'P'
      extrinsic_entry: number | null
      history: ThetaClose[]
      projection: ThetaDay[]
    }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const api = {
  trades: () => get<TradeRow[]>('/api/trades'),
  trade: (id: number) => get<TradeDetail>(`/api/trades/${id}`),
  theta: (id: number) => get<Theta>(`/api/trades/${id}/theta`),
  /** since (YYYY-MM-DD) limits the stats to a time range; without it they cover everything */
  summary: (since?: string) => get<Summary>(`/api/summary${since ? `?since=${since}` : ''}`),
  account: () => get<AccountDay[]>('/api/account'),
  costs: () => get<Costs>('/api/costs'),
  saveNotes: async (id: number, notes: { thesis?: string; post_mortem?: string }) => {
    const res = await fetch(`/api/trades/${id}/notes`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notes),
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return (await res.json()) as TradeDetail
  },
}
