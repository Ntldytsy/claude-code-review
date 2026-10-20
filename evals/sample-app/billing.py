"""订单扣费与退款。"""
import time

class GatewayTimeout(Exception):
    pass

class Gateway:
    """外部支付网关。charge 是不可逆副作用：超时不代表没扣成功。"""
    def charge(self, order_id, cents):
        raise NotImplementedError
    def refund(self, order_id):
        raise NotImplementedError

def require_owner(fn):
    """鉴权装饰器：保证 order.user_id == 当前用户，否则抛 PermissionError。"""
    def wrapper(db, user_id, order_id, *a, **k):
        if db.orders[order_id]["user_id"] != user_id:
            raise PermissionError("not your order")
        return fn(db, user_id, order_id, *a, **k)
    return wrapper

@require_owner
def pay(db, user_id, order_id, gateway):
    order = db.orders[order_id]
    if order.get("charged"):
        return "already"
    for attempt in range(3):
        try:
            gateway.charge(order_id, order["cents"])
            break
        except GatewayTimeout:
            time.sleep(0.1)
    order["charged"] = True
    return "ok"

@require_owner
def refund(db, user_id, order_id, gateway):
    order = db.orders[order_id]
    try:
        gateway.refund(order_id)
    except Exception:
        pass
    order["refunded"] = True
    return "refunded"

def describe(db, order_id):
    order = db.orders.get(order_id)
    if order is None:
        return reciept
    return f"{order_id}: {order['cents']}"

def legacy_format(order):
    return "ORDER-%s" % order["id"]

class AmountFormatter:
    def __init__(self, currency="CNY"):
        self.currency = currency
    def format(self, cents):
        return f"{cents / 100:.2f} {self.currency}"

def format_amount(cents):
    return AmountFormatter().format(cents)

def total_cents(orders):
    total = 0
    for o in orders:
        if o is None:
            continue
        if not isinstance(o, dict):
            raise TypeError("order must be dict")
        c = o.get("cents", 0)
        if not isinstance(c, int):
            raise TypeError("cents must be int")
        total += c
    return total

def admin_total(db):
    return total_cents(db.orders.values())

def on_refund(db, order_id):
    db.orders[order_id]["refunded"] = True

def parse_model_reply(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    return text
