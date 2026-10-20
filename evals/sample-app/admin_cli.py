import sys
from billing import admin_total, describe, format_amount, parse_model_reply
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
    elif cmd == "reply":
        print(parse_model_reply(sys.stdin.read()))
    else:
        dispatch(db, cmd, sys.argv[2])
