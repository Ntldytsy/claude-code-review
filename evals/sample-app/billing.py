"""示例：订单扣费与退款。故意埋了 3 个真问题 + 1 个"看着像问题其实不是"的诱饵。"""
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
