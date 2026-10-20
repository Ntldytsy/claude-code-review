# PHP 后端 · 命令映射

> **状态**：本机未安装 PHP，本文所有命令一条都没有实际运行过；因此全部置信度标签一律按 `[version-dependent]` 处理。首次用到某条先在自己项目里验一次。事实核查的修正已并入正文，以正文为准。

## PHP 后端（裸 PHP + Laravel / Symfony / CodeIgniter 4；php-fpm 或 mod_php + opcache，Supervisor 托管 queue worker，cron 调度）

### 四类动作的命令映射（审查用：语法 / 静态 / 加载冒烟 / 逻辑验证）

#### 1. 语法检查  `[version-dependent]`

```bash
# 单文件
php -l app/Http/Controllers/FooController.php

# 全仓门禁：php -l 只处理第一个文件参数，必须 -n1；直接靠 xargs 的非零退出码，别在尾部接 grep
git ls-files '*.php' | xargs -n1 -P8 php -l >/dev/null
# 只想看摘要再写成：... | grep -v 'No syntax errors' | grep -q . && { echo FAIL; exit 1; }

# 只查本次改动
git diff --name-only --diff-filter=ACM HEAD | grep '\.php$' | xargs -r -n1 php -l

# 更快的标准做法
composer require --dev php-parallel-lint/php-parallel-lint
vendor/bin/parallel-lint --exclude vendor --exclude node_modules .

# 模板/配置不在 php -l 覆盖范围内，要单独 lint
# Laravel：view:cache 只抓少量指令层错误（未闭合结构等），必须对编译产物再 lint 才是语法门禁
php artisan view:cache && find storage/framework/views -name '*.php' -print0 | xargs -0 -n1 php -l >/dev/null
php bin/console lint:twig templates          # Symfony：真正的模板解析器，结论比 view:cache 强；Blade 侧没有等价物
php bin/console lint:yaml config --parse-tags
composer validate --strict
```

> 注：门禁不能接 `| grep -v ...`：管道尾部的 grep 决定退出码，全通过时 grep 无输出退出 1（CI 判失败）、有 parse error 时 grep 匹配退出 0（CI 判通过）。Blade 编译是文本替换，`@if($a ==)`、`@php $x = @endphp` 这类编译产物里的 PHP 语法错 view:cache 照样 exit 0，直到请求渲染该视图才 500。

**说明**：php -l 只抓 parse error。use 了不存在的类、拼错方法名/属性名/变量名、参数个数不对，它一个都抓不到——这层在 PHP 里的信息量比 Python 的 compileall 更低，绝不能当"检查通过"。两个细节：(a) `php -l a.php b.php` 只 lint 第一个文件，所以必须 xargs -n1；(b) Blade/Twig 模板对 php -l 是透明的，模板语法错只能靠「view:cache + 对编译产物 php -l」/ lint:twig。



#### 2. 静态检查  `[version-dependent]`

```bash
composer require --dev phpstan/phpstan phpstan/extension-installer
# Laravel（让 PHPStan 懂 Eloquent 魔术方法/Facade，否则满屏假阳性）
composer require --dev larastan/larastan
# Symfony
composer require --dev phpstan/phpstan-symfony phpstan/phpstan-doctrine

# phpstan.neon:
#   parameters:
#     level: 6
#     paths: [app, src]
#     tmpDir: var/phpstan

vendor/bin/phpstan analyse --memory-limit=1G

# 存量项目：先冻结基线，之后报出来的就只有"这次自己新引入的"
vendor/bin/phpstan analyse --generate-baseline phpstan-baseline.neon

# 未使用的局部变量/参数：PHPStan 默认不报，用 Psalm
composer require --dev vimeo/psalm
vendor/bin/psalm --init && vendor/bin/psalm --no-cache --find-dead-code
# psalm.xml: <psalm findUnusedVariablesAndParams="true" findUnusedCode="true">

# CodeIgniter 4 自带 phpstan.neon.dist，直接 vendor/bin/phpstan analyse
```

**说明**：这层是 PHP 里唯一能替代"未定义名检查"的手段，且原 playbook 说的"最常抓到自己新引入的 bug"在 PHP 里比在 Python 里更成立——因为 PHP 没有 import 阶段，拼错的类名/方法名只在那行代码真被执行到时才炸。分工要说清:未定义变量/未定义方法/参数数量 PHPStan level 0-2 就能抓；类型不匹配、可能为 null 要 level>=6；**未使用的局部变量 PHPStan 任何 level 都不报**，必须上 Psalm 的 findUnusedVariablesAndParams。不装框架扩展直接跑 PHPStan 会被 Facade/`__get` 淹没，团队会直接放弃这层。

#### 3. 加载冒烟  `[version-dependent]`

```bash
# ---- 裸 PHP ----
php -r 'require "vendor/autoload.php"; echo "autoload ok\n";'   # 验 autoload 映射 + files 型自动加载的副作用
php -r 'require "vendor/autoload.php"; var_dump(class_exists("App\\Services\\FooService", true));'  # PSR-4 路径/大小写错在这里现形
# 入口不要 php -f public/index.php（没有请求上下文），走 HTTP：
php -S 127.0.0.1:8999 -t public & sleep 1
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8999/ ; kill %1

# ---- Laravel ----
php artisan --version                  # 证明能 boot 到 console kernel（版本无关）
php artisan config:cache && php artisan config:clear   # 证明所有 ServiceProvider 与 config 能加载/序列化（版本无关）
php artisan route:list --json > /dev/null   # 解析全部路由 + controller FQCN（9 之前输出结构不同）
php artisan route:cache && php artisan view:cache
php artisan optimize:clear             # 5.7+；本地冒烟完必须清掉，别留缓存
php artisan list | grep -q ' about ' && php artisan about   # Laravel 9+ 才有 about；先探测再跑，否则 8 及更早会以 "Command about is not defined" 非零退出、像应用加载失败

# ---- Symfony：PHP 世界里最接近"循环依赖检查"的东西 ----
php bin/console lint:container --env=prod        # 每个服务的构造参数能否解析/是否循环引用
php bin/console cache:warmup --env=prod --no-debug   # 真正编译出 var/cache/prod 的容器
php bin/console debug:router > /dev/null

# ---- CodeIgniter 4 ----
php spark routes && php spark cache:clear
```

**说明**：这里原 playbook 的心智模型会整体说错:PHP 是 share-nothing，每个请求重新 bootstrap，所谓"模块级副作用"是每请求都跑一遍，不是进程生命周期里跑一次——冒烟只能证明"能加载"，证明不了单例/初始化顺序。而 PHP 的类循环依赖本身是合法的（autoloader 懒解析），Python 那种 circular import 崩溃在 PHP 几乎不存在；真正会炸的等价物是 Symfony 的 DI 容器循环（lint:container 抓）和 legacy 代码里的 require 环。Laravel 侧最有价值的一条是 config:cache/route:cache——config 里塞了闭包、路由里用了闭包，只有这两条会炸。



#### 4. 逻辑验证  `[version-dependent]`

```bash
# ---- Laravel ----
# phpunit.xml（或 .dist）里：
#  <env name="DB_CONNECTION" value="sqlite"/>
#  <env name="DB_DATABASE" value=":memory:"/>
#  <env name="QUEUE_CONNECTION" value="sync"/>
#  <env name="MAIL_MAILER" value="array"/>
#  <env name="CACHE_DRIVER" value="array"/>   <!-- Laravel <=10 -->
#  <env name="CACHE_STORE" value="array"/>    <!-- Laravel 11+；跨版本模板两行都写，多写的无害 -->
#  <env name="SESSION_DRIVER" value="array"/>

php artisan config:clear && php artisan test --testsuite=Unit
php artisan test tests/Feature/FooTest.php
# 配置写了不等于生效：必须真断言一次 config('cache.default') 是 array（别只信配置文件）

# 测试类里：
#  use Illuminate\Foundation\Testing\RefreshDatabase;   // migrate 一次 + 每个测试包事务回滚
# 零不可逆副作用必须显式伪造外部依赖，缺一个就会真的打出去：
#  Http::fake(); Mail::fake(); Notification::fake(); Queue::fake(); Bus::fake();
#  Event::fake(); Storage::fake('s3');

# 用到 MySQL 专属 SQL（JSON 函数/FULLTEXT/ON DUPLICATE KEY）时 SQLite 会假绿，换一次性 MySQL 库：
# 另建一份配置 phpunit.mysql.xml（DB_CONNECTION=mysql、DB_DATABASE=app_test），不要靠环境变量去对抗 phpunit.xml 里写死的 sqlite
mysql -e 'DROP DATABASE IF EXISTS app_test; CREATE DATABASE app_test'
APP_ENV=testing DB_CONNECTION=mysql DB_DATABASE=app_test php artisan migrate --seed
php artisan test -c phpunit.mysql.xml
# 若坚持用环境变量：DB_CONNECTION/DB_DATABASE 必须同时 export 给 migrate 和 test 两条命令，
# 并把 phpunit.xml 里对应的 <env> 删掉或加 force="false"（<env> 与已存在环境变量谁赢取决于 force，别赌默认值）

# ---- Symfony ----
composer require --dev dama/doctrine-test-bundle   # 每个测试自动包事务并回滚
cp .env .env.test.local    # 只改 DATABASE_URL 指向一次性库
php bin/console --env=test doctrine:database:create --if-not-exists
php bin/console --env=test doctrine:migrations:migrate --no-interaction
vendor/bin/phpunit --testsuite=unit

# ---- CodeIgniter 4 ----
# app/Config/Database.php 的 $tests 组默认 SQLite3 :memory:
# 测试类：use CodeIgniter\Test\DatabaseTestTrait;  protected $refresh = true;
vendor/bin/phpunit --group=database

# ---- 裸 PHP：临时 SQLite 文件 + 断言脚本，跑完即弃 ----
export APP_ENV=test DB_DSN="sqlite:$(mktemp -t smoke).sqlite"
php tests/smoke.php   # 脚本内 require autoload、跑断言、失败 exit(1)
```

> 注：`CACHE_STORE` 是 Laravel 11 才改的名字，≤10 叫 `CACHE_DRIVER`——写错的那行不报错、不生效，测试会继续用 .env 里真实的 cache 驱动，「隔离」前提被静默破坏。另：MySQL 那条若只给 `migrate` 带环境变量、`php artisan test` 不带，测试仍在 phpunit.xml 写死的 SQLite 上跑，却会让人以为验过 MySQL。

**说明**：PHP 项目里"隔离环境"最常见的失败不是数据库，是**外部副作用没伪造**:一个 Feature 测试没写 Mail::fake()/Http::fake()，跑一次就真给用户发了邮件、真调了第三方支付。所以断言"零不可逆副作用"在 PHP 里 = 数据库隔离 + 全套 fake，两者缺一不可。`:memory:` SQLite 的边界要提前判断（每连接独立，多连接测试会看不到彼此数据）。`--parallel` 需要 brianium/paratest，会建 app_test_1..N 多个库，CI 里得预留权限。dama 的事务包裹有个硬约束:测试内部不能跑 DDL（migration/schema 变更会被事务破坏或自动提交），schema 必须在测试前建好。裸 PHP 项目最大的前置障碍是连接没有收口——代码里到处 `new PDO(...)` 硬编码 DSN 时隔离环境根本做不出来，得先把连接收进一个 factory/单入口，这是改造工作而不是测试配置工作，评审时要如实说"这条暂时不可用"，别写个假的通过。

### 本栈审查维度重点清单（替换 playbook 里 DIMS 的 focus）

- PSR-4 命名空间与文件路径/大小写是否严格一致：macOS 与 Windows 大小写不敏感，本地全绿、Linux 生产 500 "Class not found"，而 php -l 完全抓不到，只有真实加载或 PHPStan 会现形

- 严格类型与松散比较：新增/改动文件有没有 declare(strict_types=1)；== / in_array 的松散比较、empty() 对 "0"/0/[]/null 的语义差异、null 传进非可空参数（PHP 8 起是 TypeError 而不再是 warning）

- 本次改动是否触碰任何"必须重建才生效"的缓存层：config/*.php、routes、Blade 视图、event、Symfony DI 容器、composer classmap——部署脚本里有没有对应的重建步骤

- 改动落在"每请求重建"的代码还是"常驻进程"的代码：Job / Listener / Console Command / Octane 需要重启才生效；特别是 Job 的构造函数签名或属性有没有变（队列里已有的旧 payload 会反序列化失败）

- 迁移是否向后兼容（expand-contract）：滚动发布期间新旧代码同时在跑，两边都得能用；大表 DDL 的锁表时长；down() 是否真的被执行验证过

- 输入面与注入：$request->all() 直灌 Model::create/update（$fillable/$guarded 是否收紧）、whereRaw/DB::raw/字符串拼 SQL、Blade 的 {!! !!}、unserialize()/extract() 吃用户输入、上传文件的 mime 与扩展名校验

- ORM 访问模式与资源上限：Eloquent/Doctrine 的 N+1（循环里 lazy load）、缺 with()/fetch join、->get() 拉全表 vs chunkById()/cursor()、以及 memory_limit 与 max_execution_time 够不够

- 错误可见性与部署残留：生产 APP_DEBUG=false、异常处理有没有把栈泄漏给用户、@ 抑制符、catch (\Throwable) {} 静默吞异常、dd()/dump()/var_dump()/error_log 调试残留、storage/ 与 bootstrap/cache 的属主和写权限（root 部署 + www-data 运行 = 500）

### 本栈特有的坑

- **改了 Job / Message 的构造函数签名或属性，部署后队列里积压的旧任务全部炸进 failed_jobs** `[version-dependent]`
  - 为什么：Laravel/Symfony 把 job 序列化成 payload 存进队列（SerializesModels 只存模型 id），worker 用【新代码】去反序列化【旧结构】的 payload：少了属性就是 undefined property，构造参数数量变了就是 ArgumentCountError，重试几次直接进 failed_jobs。这就是 PHP 项目里"在途工作"的真实所在，它完全不在 web 层，部署前不看队列根本发现不了——原 playbook 那套 pm2 视角在这里没有对应物。
  - 怎么办：部署前断言队列干净：database 队列 `SELECT COUNT(*) FROM jobs WHERE reserved_at IS NOT NULL` = 0 且积压为 0，redis 队列 `ZCARD` 对应 reserved 队列 = 0（注意 Laravel redis 默认 key 前缀与 DB index，见 5c；先 `redis-cli --scan --pattern '*queues:default*'` 确认真实 key，别信不带前缀查出的 0）。改签名时不要改老类，新建一个 Job 类、让旧类保留一个发布周期；必须加属性就给默认值并做双读兼容。
