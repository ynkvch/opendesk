"""Black-Scholes pricing and Greeks.

Used to price the demo data (server/demo.py), and to compute IV/Greeks
from a fill price when a live snapshot from TWS is not available.
"""
from math import erf, exp, log, pi, sqrt

RATE = 0.042  # flat risk-free rate assumption


def _cdf(x: float) -> float:
    return 0.5 * (1.0 + erf(x / sqrt(2.0)))


def _pdf(x: float) -> float:
    return exp(-0.5 * x * x) / sqrt(2.0 * pi)


def price(right: str, s: float, k: float, t: float, iv: float, r: float = RATE) -> float:
    """Option price. right is 'C' or 'P'; t in years."""
    if t <= 0 or iv <= 0:
        return max(0.0, s - k) if right == "C" else max(0.0, k - s)
    d1 = (log(s / k) + (r + 0.5 * iv * iv) * t) / (iv * sqrt(t))
    d2 = d1 - iv * sqrt(t)
    if right == "C":
        return s * _cdf(d1) - k * exp(-r * t) * _cdf(d2)
    return k * exp(-r * t) * _cdf(-d2) - s * _cdf(-d1)


def greeks(right: str, s: float, k: float, t: float, iv: float, r: float = RATE) -> dict:
    """Per-share Greeks. theta is per calendar day, vega per 1 vol point."""
    t = max(t, 1e-6)
    d1 = (log(s / k) + (r + 0.5 * iv * iv) * t) / (iv * sqrt(t))
    d2 = d1 - iv * sqrt(t)
    gamma = _pdf(d1) / (s * iv * sqrt(t))
    vega = s * _pdf(d1) * sqrt(t) / 100.0
    if right == "C":
        delta = _cdf(d1)
        theta = (-s * _pdf(d1) * iv / (2 * sqrt(t)) - r * k * exp(-r * t) * _cdf(d2)) / 365.0
    else:
        delta = _cdf(d1) - 1.0
        theta = (-s * _pdf(d1) * iv / (2 * sqrt(t)) + r * k * exp(-r * t) * _cdf(-d2)) / 365.0
    return {"delta": delta, "gamma": gamma, "theta": theta, "vega": vega}


def implied_vol(right: str, opt_price: float, s: float, k: float, t: float, r: float = RATE) -> float | None:
    """Solve IV from a price by bisection. Returns None if the price is outside model bounds."""
    lo, hi = 1e-4, 5.0
    if not (price(right, s, k, t, lo, r) <= opt_price <= price(right, s, k, t, hi, r)):
        return None
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        if price(right, s, k, t, mid, r) < opt_price:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)
