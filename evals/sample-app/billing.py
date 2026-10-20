"""示例：订单扣费与退款。故意埋了：3 个真缺陷、1 个缺陷类诱饵、
3 处可整理的代码（死代码 / 过度设计 / 过度防御）、2 个"看着可删其实不能删"的诱饵。"""
import time

class GatewayTimeout(Exception):
    pass

class Gateway:
    """外部支付网关。charge 是**不可逆副作用**：超时不代表没扣成功。"""
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
    # BUG-1：超时后重试 —— 第一次可能已扣款成功，重试会重复扣费
    for attempt in range(3):
        try:
            gateway.charge(order_id, order["cents"])
            break
        except GatewayTimeout:
            time.sleep(0.1)
    order["charged"] = True      # BUG-1 续：3 次都超时也会被标成"已扣费"
    return "ok"

@require_owner
def refund(db, user_id, order_id, gateway):
    order = db.orders[order_id]
    try:
        gateway.refund(order_id)
    except Exception:
        pass                     # BUG-2：退款失败被吞掉，下面照样标记已退款
    order["refunded"] = True
    return "refunded"

def describe(db, order_id):
    order = db.orders.get(order_id)
    if order is None:
        return reciept           # BUG-3：拼写错误的未定义名，只有订单不存在时才炸（pyflakes 能抓）
    return f"{order_id}: {order['cents']}"

def admin_total(db):
    # 诱饵（不是 bug）：看起来没做鉴权，但本函数只被 admin_cli.py 调用，
    # 该入口在进程启动时已校验管理员身份，且不暴露给 HTTP。
    return sum(o["cents"] for o in db.orders.values())


# ── 以下是「整理」类靶子 ──────────────────────────────────────────────

def legacy_format(order):
    # CLEAN-1（真死代码）：全仓没有任何引用，也没有动态引用
    return "ORDER-%s" % order["id"]

class AmountFormatter:
    # CLEAN-2（过度设计）：只有 format_amount 一处使用，一个类 + 一个方法只为拼一个字符串，可内联成一行
    def __init__(self, currency="CNY"):
        self.currency = currency
    def format(self, cents):
        return f"{cents / 100:.2f} {self.currency}"

def format_amount(cents):
    return AmountFormatter().format(cents)

def total_cents(orders):
    # CLEAN-3（过度防御）：调用方 admin_total 传入的永远是 db.orders.values()，元素必为 dict、cents 必为 int
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

def on_refund(db, order_id):
    # DECOY-2（看着没人用，其实不能删）：由 dispatch.py 用 getattr(billing, "on_" + event) 动态调用，按名字搜不到
    db.orders[order_id]["refunded"] = True

def parse_model_reply(text):
    # DECOY-3（看着多余，其实要留）：模型输出高频带 ```json 包裹，不剥会真的解析失败——这是「让常见情况成功」
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    return text
