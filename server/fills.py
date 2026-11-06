"""Fills that add to or reduce an open journal trade. Shared by the Flex import and the TWS sync.

A trade is one position from first buy to last sell: buying more in several fills raises the
quantity and averages the entry; selling in several fills closes it only when nothing is left.
"""


def add_to_trade(conn, tid: int, when: str, price: float, qty: float, commission: float, exec_id: str,
                 desc: str) -> None:
    """Another opening fill: quantity grows, entry becomes the average price of all opening fills."""
    conn.execute("INSERT OR IGNORE INTO fills (trade_id, exec_id, time, action, side, description, quantity, price,"
                 " commission) VALUES (?,?,?,?,?,?,?,?,?)", (tid, exec_id, when, "OPEN", "BOT", desc, qty, price, commission))
    q, cost = conn.execute("SELECT SUM(quantity), SUM(quantity * price) FROM fills WHERE trade_id = ? AND action = 'OPEN'",
                           (tid,)).fetchone()
    conn.execute("UPDATE trades SET quantity=?, entry_price=?, max_risk=ROUND(? * multiplier * ?, 2),"
                 " commissions=commissions+? WHERE id=?", (q, cost / q, cost / q, q, commission, tid))
    conn.execute("UPDATE legs SET entry_price=? WHERE trade_id=?", (cost / q, tid))


def refresh_realized(conn, tid: int) -> None:
    """Recompute a closed trade's realized P&L after its fills or commissions changed."""
    t = conn.execute("SELECT * FROM trades WHERE id = ?", (tid,)).fetchone()
    if t["status"] != "closed":
        return
    sold, proceeds = conn.execute("SELECT SUM(quantity), SUM(quantity * price) FROM fills"
                                  " WHERE trade_id = ? AND action = 'CLOSE'", (tid,)).fetchone()
    pnl = (proceeds / sold - t["entry_price"]) * t["multiplier"] * t["quantity"] - t["commissions"]
    conn.execute("UPDATE trades SET realized_pnl=? WHERE id=?", (round(pnl, 2), tid))


def reduce_trade(conn, tid: int, when: str, price: float, qty: float, commission: float, exec_id: str,
                 desc: str) -> bool:
    """A closing fill. The trade closes once the closing fills add up to the quantity held; returns True then.
    Realized P&L is computed from all fills, net of every commission."""
    conn.execute("INSERT OR IGNORE INTO fills (trade_id, exec_id, time, action, side, description, quantity, price,"
                 " commission) VALUES (?,?,?,?,?,?,?,?,?)", (tid, exec_id, when, "CLOSE", "SLD", desc, qty, price, commission))
    conn.execute("UPDATE trades SET commissions=commissions+? WHERE id=?", (commission, tid))
    t = conn.execute("SELECT * FROM trades WHERE id = ?", (tid,)).fetchone()
    sold, proceeds = conn.execute("SELECT SUM(quantity), SUM(quantity * price) FROM fills"
                                  " WHERE trade_id = ? AND action = 'CLOSE'", (tid,)).fetchone()
    if sold < t["quantity"] - 1e-9:
        return False
    exit_price = proceeds / sold
    pnl = (exit_price - t["entry_price"]) * t["multiplier"] * t["quantity"] - t["commissions"]
    conn.execute("UPDATE trades SET status='closed', closed_at=?, exit_price=?, realized_pnl=?,"
                 " und_exit=CASE WHEN asset='STK' THEN ? ELSE und_exit END WHERE id=?",
                 (when, exit_price, round(pnl, 2), exit_price, tid))
    conn.execute("UPDATE legs SET exit_price=? WHERE trade_id=?", (exit_price, tid))
    return True
