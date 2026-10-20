# 技术栈映射 · Python 后端

> 验证状态：本文每条命令都在 macOS + Python 3.12 + pyflakes 3.4.0 上实际跑过一次，并核对了退出码。
> **没跑过**的写在末尾「未验证」一节。框架相关（Django/FastAPI/Celery）的命令未实测，只给方向。

## 四类动作（审查用：语法 / 静态 / 加载冒烟 / 逻辑验证）

### 1. 语法检查 `[confident]`

```bash
python3 -m compileall -q <包目录>          # 有语法错 → 退出码 1，并指出文件和行
git diff --name-only HEAD | grep '\.py$' | xargs -r python3 -m py_compile   # 只查本次改动
```

只抓 parse error。**拼错的变量名、没导入的名字它一个都抓不到**（实测：`return p` 里 `p` 未定义，compileall 通过）。

### 2. 静态检查 `[confident]`

```bash
python3 -m pyflakes <文件或目录>           # 有问题 → 退出码 1；干净 → 0，无输出
```

实测能抓：`undefined name`、`imported but unused`、`assigned to but never used`。
这层最常抓到「改的过程中自己新引入的 bug」，例如把 `s, p = f()` 改成 `s, _ = f()` 却继续用 `p`。

- 门禁直接依赖退出码，**别在管道尾部接 grep**（会反转退出码，见 playbook §6）。
- 项目已有 `ruff` / `flake8` / `mypy` 配置就用项目自己的。`ruff` 本机未装，命令未实测：`ruff check <目录>`。
- 存量项目噪音大时，先只检查本次改动文件，别一上来全仓。

### 3. 加载冒烟 `[confident]`

```bash
python3 -c "import <包名>; print('ok')"            # 真加载入口模块
python3 -c "import <包名>.<子模块>"                 # 循环依赖、模块级副作用在这里炸（退出码 1）
```

注意：函数体里的 `NameError` 在 import 时**不会**暴露（实测通过），所以冒烟不能代替静态检查。
模块级会连数据库/起线程的代码，冒烟时要指向隔离环境，别连生产。

### 4. 逻辑验证 `[confident]`

```bash
python3 - <<'EOF'
import sqlite3
c = sqlite3.connect(':memory:')        # 隔离库：零外部调用、可反复跑
# 建表 → 塞假数据 → 直接调服务层函数 → assert
EOF
```

项目已有 pytest：把断言沉淀成用例，用 `pytest -x -q <路径>`（未实测，pytest 是否安装依项目而定）。
用 ORM 时，把连接串指向 `sqlite:///:memory:` 或临时文件库，并**先断言连的确实是它**再往下跑。

## 本栈审查维度重点清单（替换 `DIMS` 里 `backend-bugs` 的 focus）

```
- 事务边界：中途多次 commit 时，异常路径留下什么状态；`with session` / `atexit` / 异常被 `except Exception: pass` 吞掉
- 异步/线程里的数据库连接：连接/会话是否跨线程、跨请求复用；后台任务里 session 的生命周期
- `except` 太宽：吞掉 `KeyboardInterrupt` 之外的一切后，失败被当成功继续往下走
- 可变默认参数 `def f(x=[])`、模块级可变全局在多请求间互相污染
- 并发写同一行：先查后写（check-then-act）没有锁/唯一约束/`SELECT ... FOR UPDATE`
- 重试/超时：对**已产生不可逆副作用**的调用（扣费、发信）做了自动重试
- 字符串拼 SQL / `subprocess(shell=True)` / `pickle.loads` / `yaml.load` 吃外部输入
- 时间：naive 与 aware datetime 混用；用本地时间做存储或比较
```

## 未验证

Django（`manage.py check` / `makemigrations --check`）、FastAPI、Celery、Alembic 的命令本文没有给，**因为没实测**。
需要时按 `stack-mapping.md` 末尾的「新栈清单」自己补一遍，并标上 `[version-dependent]`。
