import billing

def dispatch(db, event, order_id):
    return getattr(billing, "on_" + event)(db, order_id)
