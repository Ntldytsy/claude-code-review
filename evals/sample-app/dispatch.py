import billing

def dispatch(db, event, order_id):
    # 按事件名动态分发：on_<事件名>
    return getattr(billing, "on_" + event)(db, order_id)
