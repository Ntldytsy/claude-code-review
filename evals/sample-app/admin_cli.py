import sys
from billing import Batch, OrderState, admin_total, channel_fees, describe, format_amount, load_meta, load_tags, mark, order_report, parse_model_reply
from dispatch import dispatch

def main(db):
    if db.current_user_role != "admin":
        sys.exit("admin only")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "total"
    if cmd == "total":
        print(format_amount(admin_total(db)))
    elif cmd == "list":
        for oid in db.orders:
            print(describe(db, oid))
    elif cmd == "report":
        print(order_report(db))
        print(channel_fees(db, ["alipay", "wechat", "card"]))
    elif cmd == "batch":
        b = Batch()
        for oid in db.orders:
            b.add(oid)
            st = mark(OrderState(), "paid")
            print(b.count, st.is_paid, load_meta(db.raw_meta), load_tags(db.raw_tags))
    elif cmd == "reply":
        print(parse_model_reply(sys.stdin.read()))
    else:
        dispatch(db, cmd, sys.argv[2])
