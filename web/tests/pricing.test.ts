// pricing maths behind the risk manager heatmap. run: npm test (node's built-in test runner)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RATE, bsPrice, scenarioPnl, type Scenario } from '../src/lib/payoff.ts'
import { nyAt, nyDay, timeSteps } from '../src/lib/risk.ts'

// reference prices from scipy.stats.norm at r = 4.2%, an independent black-scholes implementation:
// [right, spot, strike, years, iv, price]
const REFERENCE: [('C' | 'P'), number, number, number, number, number][] = [
  ['C', 100, 100, 0.0821917808219178, 0.25, 3.029406],
  ['P', 100, 100, 0.0821917808219178, 0.25, 2.684795],
  ['C', 161.07, 155, 0.010958904109589041, 0.689, 8.260353],
  ['P', 161.07, 155, 0.010958904109589041, 0.689, 2.119027],
  ['P', 160.83, 170, 0.0821917808219178, 0.5927, 15.990122],
  ['C', 50, 60, 1.0, 0.4, 5.268064],
  ['P', 50, 60, 1.0, 0.4, 12.800251],
  ['P', 159.9, 160, 0.0027397260273972603, 0.66, 2.245206],
]

const near = (a: number, b: number, tol: number, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (tol ${tol})`)
const pdf = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)

test('black-scholes matches scipy reference prices to 1e-5', () => {
  for (const [right, s, k, t, iv, want] of REFERENCE) near(bsPrice(right, s, k, t, iv), want, 1e-5, `${right} ${s}/${k} t=${t} iv=${iv}`)
})

test('put-call parity holds: C - P = S - K e^(-rT)', () => {
  for (const [s, k, t, iv] of [[100, 100, 0.08, 0.25], [161.07, 155, 0.011, 0.689], [50, 60, 1, 0.4], [30, 25, 0.5, 1.2]]) {
    near(bsPrice('C', s, k, t, iv) - bsPrice('P', s, k, t, iv), s - k * Math.exp(-RATE * t), 1e-6, `parity ${s}/${k}`)
  }
})

test('raising iv raises the price, at the rate vega predicts', () => {
  for (const right of ['C', 'P'] as const) {
    const [s, k, t] = [161.07, 155, 30 / 365]
    let prev = 0
    for (let iv = 0.1; iv <= 1.5; iv += 0.05) {
      const p = bsPrice(right, s, k, t, iv)
      assert.ok(p > prev, `${right} price should rise with iv: ${p} at ${iv.toFixed(2)} after ${prev}`)
      prev = p
    }
    // analytic vega S·φ(d1)·√T (the same for calls and puts) against a central finite difference
    const iv = 0.6, h = 1e-4
    const d1 = (Math.log(s / k) + (RATE + iv * iv / 2) * t) / (iv * Math.sqrt(t))
    const fd = (bsPrice(right, s, k, t, iv + h) - bsPrice(right, s, k, t, iv - h)) / (2 * h)
    near(fd, s * pdf(d1) * Math.sqrt(t), 1e-4, `${right} vega`)
  }
})

test('at expiry an option is worth its intrinsic value', () => {
  near(bsPrice('C', 170, 160, 0, 0.5), 10, 1e-12)
  near(bsPrice('C', 150, 160, 0, 0.5), 0, 1e-12)
  near(bsPrice('P', 150, 160, 0, 0.5), 10, 1e-12)
  near(bsPrice('P', 170, 160, -1, 0.5), 0, 1e-12)
})

const NOW = Date.UTC(2026, 10, 16, 15, 0)
const pos: Scenario = {
  right: 'P', side: 'BUY', strike: 155, spot: 161.07, entry: 2.12, iv: 0.689,
  multiplier: 100, quantity: 2, commissions: 1.79, expiresAt: NOW + 4 * 86_400_000,
}

test('heatmap cell = (model value - entry) x multiplier x contracts - commissions', () => {
  for (const [pct, pts] of [[0, 0], [-5, 0], [3, 10], [-10, -20], [10, 20]]) {
    const t = 4 / 365
    const want = (bsPrice('P', 161.07 * (1 + pct / 100), 155, t, 0.689 + pts / 100) - 2.12) * 200 - 1.79
    near(scenarioPnl(pos, pct, pts, NOW), want, 1e-9, `cell ${pct}% / ${pts} pts`)
  }
})

test('each vol row shifts iv by its points, and never below 5%', () => {
  const t = 4 / 365
  for (const pts of [20, 15, 10, 5, 0, -5, -10, -15, -20]) {
    const v = (scenarioPnl(pos, 0, pts, NOW) + 1.79) / 200 + 2.12
    near(v, bsPrice('P', 161.07, 155, t, 0.689 + pts / 100), 1e-9, `row ${pts}`)
  }
  const low = { ...pos, iv: 0.12 }
  near(scenarioPnl(low, 0, -20, NOW), scenarioPnl(low, 0, -7, NOW), 1e-9, 'floored at 5%')
  // a long option gains as vol rises in every column
  for (const pct of [-10, -5, 0, 5, 10]) assert.ok(scenarioPnl(pos, pct, 5, NOW) > scenarioPnl(pos, pct, 0, NOW))
})

test('a short position is the mirror of the long one, less commissions on both', () => {
  const short = { ...pos, side: 'SELL' as const }
  for (const [pct, pts] of [[0, 0], [-8, 5], [6, -10]]) {
    near(scenarioPnl(short, pct, pts, NOW) + pos.commissions, -(scenarioPnl(pos, pct, pts, NOW) + pos.commissions), 1e-9)
  }
})

test('at the expiry step the heatmap shows intrinsic value', () => {
  near(scenarioPnl(pos, -10, 0, pos.expiresAt), (155 - 161.07 * 0.9 - 2.12) * 200 - 1.79, 1e-9)
  near(scenarioPnl(pos, 5, 0, pos.expiresAt), -2.12 * 200 - 1.79, 1e-9, 'out of the money: lose the premium')
})

test('new york times convert to utc across the daylight saving change', () => {
  assert.equal(new Date(nyAt('2026-11-20', 16)).toISOString(), '2026-11-20T21:00:00.000Z') // est, utc-5
  assert.equal(new Date(nyAt('2026-07-17', 16)).toISOString(), '2026-07-17T20:00:00.000Z') // edt, utc-4
  assert.deepEqual(nyDay(Date.UTC(2026, 10, 14, 3)), { day: '2026-11-13', weekday: 'Fri' })
})

test('time slider: daily closes on weekdays, ending at expiry', () => {
  const now = nyAt('2026-11-13', 11), exp = nyAt('2026-11-20', 16)
  const steps = timeSteps(now, exp)
  assert.equal(steps[0], now)
  assert.equal(steps.at(-1), exp)
  const days = steps.slice(1).map((t) => nyDay(t).weekday)
  assert.deepEqual(days, ['Fri', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'])
})

test('time slider: 30-minute steps inside sessions when expiry is 3 days or less away', () => {
  const now = nyAt('2026-11-16', 10, 7), exp = nyAt('2026-11-17', 16)
  const steps = timeSteps(now, exp)
  assert.equal(steps.at(-1), exp)
  // monday 10:30 to 16:00 is 12 steps, tuesday 10:00 to 16:00 is 13, plus now
  assert.equal(steps.length, 1 + 12 + 13)
  for (const t of steps.slice(1)) {
    const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }).format(t)
    assert.ok(hm >= '09:30' && hm <= '16:00', `step outside the session: ${hm}`)
    assert.equal((t - nyAt(nyDay(t).day, 9, 30)) % (30 * 60_000), 0)
  }
})

test('pre/post market: entering at the model price makes the "now" column flat before commissions', () => {
  // outside regular hours the entry defaults to black-scholes at the live spot and the latest iv, valued now
  for (const side of ['BUY', 'SELL'] as const) {
    for (const right of ['C', 'P'] as const) {
      const model = bsPrice(right, 161.07, 155, (pos.expiresAt - NOW) / (365 * 86_400_000), 0.689)
      const p = { ...pos, side, right, entry: model }
      near(scenarioPnl(p, 0, 0, NOW), -p.commissions, 1e-9, `${side} ${right}`)
    }
  }
})

test('vol rows reach +/-30 points', () => {
  const t = 4 / 365
  for (const pts of [30, -30]) {
    const v = (scenarioPnl(pos, 0, pts, NOW) + 1.79) / 200 + 2.12
    near(v, bsPrice('P', 161.07, 155, t, 0.689 + pts / 100), 1e-9, `row ${pts}`)
  }
})
