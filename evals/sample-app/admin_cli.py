import sys
from billing import admin_total

def main(db):
    # 启动时校验：非管理员直接退出，admin_total 不会被其他入口调用
    if db.current_user_role != "admin":
        sys.exit("admin only")
    print(admin_total(db))
