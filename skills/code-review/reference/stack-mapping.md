# 技术栈映射 · PHP / Node.js / 纯HTML / Vue2

> 配套 `CODE-REVIEW-PLAYBOOK.md`（其命令按 Python/Vue3 写）。本文把七类动作换成上述四栈的命令。

> ⚠️ **这是 agent 原始产出 + 事实核查修正，我没有逐条整合。**
> **用任何命令前先看第 1 节**——核查员在里面挑出了 15 条标着「confident」却跑不通或说错的条目。

> 置信度：`confident`=可放心用 · `version-dependent`=依赖版本/配置，先在项目里确认一次 · `uncertain`=仅供参考


---

## 1. 事实核查说明（先读这段）

本文各节由 agent 产出，随后经过一轮独立事实核查，查出 **15 条**标着 `confident`
却跑不通或说错的条目——例如让退出码反转的管道、被误用成 `--follow` 的 `rg -L`、
写不进 `/dev/null` 目录的 babel/esbuild 命令、拿容器去取镜像字段的 `docker inspect`。

**这 15 条修正已全部内联到对应小节**，以 `> ⚠️ 修正（事实核查 N）` 引用块标出，
紧跟在被修正的命令下方。**看到修正标记时以修正为准，不要照抄它上面的原始命令。**

被修正的条目分布：

- **[PHP 后端]**：6. 重启会不会中断在途工作；1. 语法检查；7. 回滚；4. 逻辑验证（Laravel）；1. 语法检查；5. 部署后是否需要重启（第二条，重建框架缓存）；4. 逻辑验证（Laravel）；3. 加载冒烟
- **[纯 HTML / jQuery 前端]**：7. 「只有新版本才有的可观测差异」断言；7. 可观测差异断言；1. 语法检查（本栈特有：跨文件全局作用域）
- **[Vue 2 前端]**：4. 生命周期钩子 + 「卸载不停轮询」修法；1. 语法检查
- **[Node.js 后端]**：语法检查；新版本可观测差异

> ⚠️ **仍未验证**：本文所有命令**都没有在真实项目里跑过**（PHP 相关一条都没有——
> 整理时本机没装 PHP）。首次用到某条时，请在自己项目里先验一次再信。


---


## PHP 后端（裸 PHP + Laravel / Symfony / CodeIgniter 4；php-fpm 或 mod_php + opcache，Supervisor 托管 queue worker，cron 调度）

### 七类动作的命令映射

#### 1. 语法检查  `[confident]`

```bash
# 单文件
php -l app/Http/Controllers/FooController.php

# 全仓：php -l 只处理第一个文件参数，必须 -n1
git ls-files '*.php' | xargs -n1 -P8 php -l | grep -v 'No syntax errors'

# 只查本次改动
git diff --name-only --diff-filter=ACM HEAD | grep '\.php$' | xargs -r -n1 php -l

# 更快的标准做法
composer require --dev php-parallel-lint/php-parallel-lint
vendor/bin/parallel-lint --exclude vendor --exclude node_modules .

# 模板/配置不在 php -l 覆盖范围内，要单独 lint
php artisan view:cache                      # Laravel: 编译全部 Blade，语法错在这里炸
php bin/console lint:twig templates          # Symfony
php bin/console lint:yaml config --parse-tags
composer validate --strict
```

**说明**：php -l 只抓 parse error。use 了不存在的类、拼错方法名/属性名/变量名、参数个数不对，它一个都抓不到——这层在 PHP 里的信息量比 Python 的 compileall 更低，绝不能当"检查通过"。两个细节：(a) `php -l a.php b.php` 只 lint 第一个文件，所以必须 xargs -n1；(b) Blade/Twig 模板对 php -l 是透明的，模板语法错只能靠 view:cache / lint:twig。

> ⚠️ **修正（事实核查 1.2）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：这条被当作「全仓门禁」，但退出码完全反过来：全部通过时 grep 没有任何输出、退出 1（CI 判失败）；有 parse error 时 grep 匹配到并输出、退出 0（CI 判通过）。管道尾部的 grep 决定整条命令的退出码。
>
> **应改为**：门禁不要接 grep：`git ls-files '*.php' | xargs -n1 -P8 php -l >/dev/null` 直接靠 xargs 的非零退出码；只想看摘要再写成 `... | grep -v 'No syntax errors' | grep -q . && { echo FAIL; exit 1; }`。


> ⚠️ **修正（事实核查 1.11）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：过度断言。Blade 编译本质是正则/文本替换，把 `@if(...)`、`{{ }}`、`@php` 里的内容原样搬进生成的 PHP。像 `@if($a ==)`、`@php $x = @endphp` 这类**编译产物里的 PHP 语法错**，view:cache 照样 exit 0，直到请求真的渲染那个视图才 500。它能抓的只是少量指令层错误（未闭合的结构等）。把它当「模板语法门禁」会给出和 `php -l` 同级别的假安全感，而这一条正是全篇用来补 `php -l` 覆盖不到模板的那一环。
>
> **应改为**：写成两步才成立：`php artisan view:cache && find storage/framework/views -name '*.php' -print0 | xargs -0 -n1 php -l`（对编译产物再 lint 才是真的语法门禁）；并注明 Symfony 的 `lint:twig` 是真正的模板解析器、结论比 view:cache 强，Blade 侧没有等价物。


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

#### 3. 加载冒烟  `[confident]`

```bash
# ---- 裸 PHP ----
php -r 'require "vendor/autoload.php"; echo "autoload ok\n";'   # 验 autoload 映射 + files 型自动加载的副作用
php -r 'require "vendor/autoload.php"; var_dump(class_exists("App\\Services\\FooService", true));'  # PSR-4 路径/大小写错在这里现形
# 入口不要 php -f public/index.php（没有请求上下文），走 HTTP：
php -S 127.0.0.1:8999 -t public & sleep 1
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8999/ ; kill %1

# ---- Laravel ----
php artisan about                      # boot 全部 ServiceProvider + 读全部 config
php artisan route:list --json > /dev/null   # 解析全部路由 + controller FQCN
php artisan config:cache && php artisan route:cache && php artisan view:cache
php artisan optimize:clear             # 本地冒烟完必须清掉，别留缓存

# ---- Symfony：PHP 世界里最接近"循环依赖检查"的东西 ----
php bin/console lint:container --env=prod        # 每个服务的构造参数能否解析/是否循环引用
php bin/console cache:warmup --env=prod --no-debug   # 真正编译出 var/cache/prod 的容器
php bin/console debug:router > /dev/null

# ---- CodeIgniter 4 ----
php spark routes && php spark cache:clear
```

**说明**：这里原 playbook 的心智模型会整体说错:PHP 是 share-nothing，每个请求重新 bootstrap，所谓"模块级副作用"是每请求都跑一遍，不是进程生命周期里跑一次——冒烟只能证明"能加载"，证明不了单例/初始化顺序。而 PHP 的类循环依赖本身是合法的（autoloader 懒解析），Python 那种 circular import 崩溃在 PHP 几乎不存在；真正会炸的等价物是 Symfony 的 DI 容器循环（lint:container 抓）和 legacy 代码里的 require 环。Laravel 侧最有价值的一条是 config:cache/route:cache——config 里塞了闭包、路由里用了闭包，只有这两条会炸。

> ⚠️ **修正（事实核查 1.14）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：`php artisan about` 是 Laravel 9 才加的命令，Laravel 8 及更早不存在，冒烟脚本会以「Command "about" is not defined」非零退出，看起来像应用加载失败。整条被标 confident，但里面至少两处有版本门槛（`about` = 9+，`optimize:clear` = 5.7+；`route:list --json` 在 9 之前的输出结构也不同）。
>
> **应改为**：标 version-dependent，并给版本无关的等价物：`php artisan --version`（证明能 boot 到 console kernel）+ `php artisan config:cache && php artisan config:clear`（证明所有 ServiceProvider 与 config 能加载/序列化）；Laravel 9+ 再补 `php artisan about`。或在脚本里先 `php artisan list | grep -q ' about '` 再决定跑不跑。


#### 4. 逻辑验证  `[confident]`

```bash
# ---- Laravel ----
# phpunit.xml（或 .dist）里：
#  <env name="DB_CONNECTION" value="sqlite"/>
#  <env name="DB_DATABASE" value=":memory:"/>
#  <env name="QUEUE_CONNECTION" value="sync"/>
#  <env name="MAIL_MAILER" value="array"/>
#  <env name="CACHE_STORE" value="array"/>
#  <env name="SESSION_DRIVER" value="array"/>

php artisan config:clear && php artisan test --testsuite=Unit
php artisan test tests/Feature/FooTest.php

# 测试类里：
#  use Illuminate\Foundation\Testing\RefreshDatabase;   // migrate 一次 + 每个测试包事务回滚
# 零不可逆副作用必须显式伪造外部依赖，缺一个就会真的打出去：
#  Http::fake(); Mail::fake(); Notification::fake(); Queue::fake(); Bus::fake();
#  Event::fake(); Storage::fake('s3');

# 用到 MySQL 专属 SQL（JSON 函数/FULLTEXT/ON DUPLICATE KEY）时 SQLite 会假绿，换一次性 MySQL 库：
mysql -e 'DROP DATABASE IF EXISTS app_test; CREATE DATABASE app_test'
APP_ENV=testing DB_DATABASE=app_test php artisan migrate --seed && php artisan test
```

**说明**：PHP 项目里"隔离环境"最常见的失败不是数据库，是**外部副作用没伪造**:一个 Feature 测试没写 Mail::fake()/Http::fake()，跑一次就真给用户发了邮件、真调了第三方支付。所以断言"零不可逆副作用"在 PHP 里 = 数据库隔离 + 全套 fake，两者缺一不可。`:memory:` SQLite 的边界要提前判断（每连接独立，多连接测试会看不到彼此数据）。`--parallel` 需要 brianium/paratest，会建 app_test_1..N 多个库，CI 里得预留权限。

> ⚠️ **修正（事实核查 1.7）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：`CACHE_STORE` 是 Laravel 11 才改的名字，Laravel 10 及更早叫 `CACHE_DRIVER`。在 ≤10 的项目里这一行不报错、不生效，测试会继续用 .env 里的真实 cache 驱动（redis/memcached/file），于是「隔离环境」这条的前提被静默破坏 —— 而该条被标 confident。同一块里 `QUEUE_CONNECTION`/`MAIL_MAILER`/`SESSION_DRIVER` 没改名，只有这一个变了，最容易漏。
>
> **应改为**：标 version-dependent，并按版本写：Laravel ≤10 用 `CACHE_DRIVER=array`，11+ 用 `CACHE_STORE=array`，跨版本模板里两行都写（多写的那行无害）。同理提醒一句「加完必须 `php artisan config:clear`，且要真的断言一次 `config('cache.default')` 是 array，别只信配置文件写了」。


> ⚠️ **修正（事实核查 1.13）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：这条达不到它宣称的效果（「换一次性 MySQL 库跑」）。两处断链：(a) 环境变量只作用于前半条 `migrate`，`&&` 后面的 `php artisan test` 一个变量都没带；(b) 同一条目上面的 phpunit.xml 已经写死 `<env name="DB_CONNECTION" value="sqlite"/>` 和 `DB_DATABASE=:memory:`，所以测试无论如何还在 SQLite 上跑 —— 而这条存在的理由正是「用到 MySQL 专属 SQL 时 SQLite 会假绿」。照抄的人会以为自己验过 MySQL 了。
>
> **应改为**：另建一份配置而不是靠环境变量对抗：`phpunit.mysql.xml`（DB_CONNECTION=mysql、DB_DATABASE=app_test），跑 `php artisan test -c phpunit.mysql.xml`；若坚持用环境变量，必须 `DB_CONNECTION=mysql DB_DATABASE=app_test` 同时 export 给 migrate 和 test 两条命令，并把 phpunit.xml 里对应的 `<env>` 加 `force="false"`/删掉（PHPUnit 的 `<env>` 与已存在的环境变量谁赢取决于 force 属性，别赌默认值）。


#### 4. 逻辑验证  `[confident]`

```bash
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

**说明**：dama 的事务包裹有个硬约束:测试内部不能跑 DDL（migration/schema 变更会被事务破坏或自动提交），schema 必须在测试前建好。裸 PHP 项目最大的前置障碍是连接没有收口——代码里到处 `new PDO(...)` 硬编码 DSN 时隔离环境根本做不出来，得先把连接收进一个 factory/单入口，这是改造工作而不是测试配置工作，评审时要如实说"这条暂时不可用"，别写个假的通过。

#### 5. 部署后是否需要重启  `[version-dependent]`

```bash
# 结论：mod_php / php-fpm 下改 .php 文件【不需要重启】，下一个请求就是新代码——前提是 opcache 会 revalidate。

# 先看 FPM（不是 CLI！）的真实 opcache 配置
cachetool opcache:status --fcgi=/run/php/php8.3-fpm.sock
# 没有 cachetool 就临时放个 phpinfo 页看，或：
php-fpm8.3 -i | grep -E 'opcache\.(enable|validate_timestamps|revalidate_freq|revalidate_path|preload)'

# A) validate_timestamps=1（默认）+ revalidate_freq=2（默认）
#    → 按文件 mtime 自动生效，最多滞后 2 秒，什么都不用做。别重启。

# B) validate_timestamps=0（生产常见调优）→ 永远不生效，必须重置 opcache：
composer global require gordalina/cachetool
cachetool opcache:reset --fcgi=/run/php/php8.3-fpm.sock
# 或优雅 reload（顺带重启 worker 进程）：
sudo systemctl reload php8.3-fpm

# C) opcache.preload 有值 / Octane / Swoole / RoadRunner / FrankenPHP worker 模式
#    → 代码常驻内存，必须真重启：
sudo systemctl restart php8.3-fpm
php artisan octane:reload
```

**说明**：原 playbook 的"部署后重启"在 PHP web 层默认是**多余且有害**的（reload 配 process_control_timeout=0 会丢在途请求）。判断只看三件事:validate_timestamps、有没有 preload、是不是常驻 worker 模式。最容易踩的是 `php -r 'opcache_reset();'`——CLI 和 FPM 是不同进程、不同共享内存段，CLI 重置对 FPM 零效果，必须经 fcgi socket（cachetool）或 reload FPM。systemctl reload 是否连带清 opcache 依赖发行版单元文件与 PHP 版本（SIGUSR2 重建子进程通常会清），所以标 version-dependent；要确定性就用 cachetool。

#### 5. 部署后是否需要重启  `[version-dependent]`

```bash
# PHP 版的"重启"其实是【重建框架缓存】，这一步漏了就是最典型的"部署了但没生效"

# ---- Laravel（顺序重要：先 clear 再 cache）----
composer install --no-dev --optimize-autoloader --classmap-authoritative
php artisan optimize:clear
php artisan migrate --force
php artisan optimize          # = config:cache + event:cache + route:cache + view:cache
php artisan queue:restart     # worker 必须单独收尾，见下一条
# 逐条等价写法：
php artisan config:cache && php artisan route:cache && php artisan event:cache && php artisan view:cache

# ---- Symfony ----
composer install --no-dev --optimize-autoloader
APP_ENV=prod php bin/console cache:clear
APP_ENV=prod php bin/console cache:warmup
APP_ENV=prod php bin/console doctrine:migrations:migrate --no-interaction
APP_ENV=prod php bin/console messenger:stop-workers

# ---- CodeIgniter 4 ----
php spark cache:clear   # CI4 没有 config/route 编译缓存，坑面小得多
```

**说明**：不清各自会怎样，逐个说清:(a) `bootstrap/cache/config.php` 存在时 Laravel 运行期**完全不读 .env**（config 文件之外的 env() 直接返回 null），改了 config/*.php 或 .env 不重新 config:cache 就等于没改；(b) route:cache 存在时新增路由一律 404，且路由里有闭包会直接 cache 失败；(c) Blade 按 mtime 判过期通常自动重编译，但用 `rsync -t`/`cp -p` 保留了旧 mtime 就会一直吃旧编译产物，需 view:clear；(d) Symfony 在 APP_DEBUG=0 下容器不做变更检测，改了服务定义/attribute 不 warmup 就是旧容器。`artisan optimize` 具体包含哪些子命令在 Laravel 各大版本里变过（5.6 曾被移除、9+ 重新定义），所以生产脚本里我倾向写逐条命令而不是 optimize。

> ⚠️ **修正（事实核查 1.12）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：对 CI4 ≥ 4.5 不成立。4.5 起有 `php spark optimize`，会开启 Config 缓存与 FileLocator 缓存（落在 writable/cache 下的 FactoriesCache_config / FileLocatorCache），部署后不重跑就会吃旧配置/旧类映射 —— 正是这条要防的「部署了但没生效」。而 `spark cache:clear` 清的是应用数据缓存（Cache handler 存储），不清这两个优化缓存，照抄会以为清干净了。（路由无编译缓存这半句是对的。）
>
> **应改为**：改成：CI4 无路由编译缓存；但 4.5+ 若启用过 `spark optimize`，部署收尾必须 `php spark optimize`（重建）或删除 writable/cache 下的 FactoriesCache_config 与 FileLocatorCache，`spark cache:clear` 不覆盖它们。并注明 4.4 及更早才是「没有这层缓存」。


#### 6. 重启会不会中断在途工作  `[confident]`

```bash
# 【必须重启才生效】的常驻进程：queue:work / horizon / messenger:consume / schedule:work / Octane / Swoole
# 【不需要重启】的：php-fpm 请求代码、cron（每次新进程）、queue:listen（每 job 重新 bootstrap）

# --- 部署前断言"无在途任务" ---
# database 队列（注意 tinker 是 dev 依赖，--no-dev 的生产机上没有，直接查库最稳）
mysql -N -e "SELECT COUNT(*) FROM jobs WHERE reserved_at IS NOT NULL" app_prod   # 期望 0
mysql -N -e "SELECT COUNT(*) FROM jobs" app_prod                                   # 积压
# redis 队列
redis-cli LLEN queues:default
redis-cli ZCARD queues:default:reserved      # 期望 0
redis-cli ZCARD queues:default:delayed
# Horizon
php artisan horizon:status
# 还在跑的长命令/长 cron
pgrep -af 'artisan (queue:work|horizon|schedule:run|.*import)'

# --- 优雅收尾：做完当前 job 才退出，不打断在途 ---
php artisan queue:restart            # Laravel：写缓存标记，worker 自杀，Supervisor 拉起
php artisan horizon:terminate
php bin/console messenger:stop-workers   # Symfony 同机制
sudo supervisorctl status | grep -v RUNNING
# 硬重启（会打断在途 job，仅在确认 reserved=0 后用）
sudo supervisorctl restart laravel-worker:*

# --- FPM 侧不丢在途请求 ---
# /etc/php/8.3/fpm/php-fpm.conf: process_control_timeout = 10s   （默认 0）
sudo systemctl reload php8.3-fpm
```

**说明**：这是 PHP 项目里"在途工作"的真正位置——不在 web 层（每请求独立，reload 配好 process_control_timeout 就是零中断），而在 Supervisor 托管的 worker 和长 cron。三个必须知道的细节:(1) `queue:restart` 靠共享 cache store 传信号，cache driver 是 file 且 worker 在别的机器上时信号传不过去，那台机器必须单独执行或 supervisorctl restart；(2) `queue:listen` 每个 job 重新 bootstrap 框架，改代码自动生效不用重启，代价是慢，灰度期可临时切过去；(3) 正在跑的长 cron 用的是**旧代码**却面对**新表结构**，这是滚动发布期最容易炸的组合，所以迁移必须向后兼容。生产机上 `php artisan tinker` 常常不存在（laravel/tinker 是 require-dev），断言脚本别依赖它。

> ⚠️ **修正（事实核查 1.1）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：Laravel 的 redis 连接默认带 key 前缀（config/database.php 里 `'prefix' => env('REDIS_PREFIX', Str::slug(env('APP_NAME','laravel'),'_').'_database_')`），真实 key 是 `laravel_database_queues:default`。照抄这两条命令在几乎所有默认配置的项目上恒返回 0/空，而文档写的期望值正是 0 —— 这是典型的假绿：队列里明明有 reserved job 也会判定为「无在途任务」，然后硬重启打断 job。另外 redis DB index 不是 0 时同样落空。
>
> **应改为**：先确认前缀再断言：`php artisan tinker` 不可用时读 config 或直接 `redis-cli --scan --pattern '*queues:default*'` 看真实 key；断言写成 `redis-cli LLEN "${REDIS_PREFIX}queues:default"`、`redis-cli -n $REDIS_DB ZCARD "${REDIS_PREFIX}queues:default:reserved"`。并补一句「如果 LLEN 返回 (nil)/0 且你确信有积压，先怀疑前缀而不是相信 0」。


#### 7. 回滚  `[confident]`

```bash
# 前提：release 目录 + symlink 原子切换
sudo ln -sfn /var/www/releases/20260903T101500 /var/www/current
cachetool opcache:reset --fcgi=/run/php/php8.3-fpm.sock   # 必须！否则 realpath/opcache 还指旧路径
php /var/www/current/artisan optimize:clear && php /var/www/current/artisan optimize
php /var/www/current/artisan queue:restart                # worker 不重启就还在跑新代码
sudo systemctl reload php8.3-fpm                          # 有 preload/Octane 时改成 restart

# 用 Deployer
dep rollback production

# DB：先看会执行什么再决定
php artisan migrate:status
php artisan migrate --pretend
php artisan migrate:rollback --step=1
php bin/console doctrine:migrations:migrate prev --dry-run
```

**说明**：代码回滚在 PHP 里最干净（切 symlink + 重置 opcache 就完事，不需要重新构建），但**DB 回滚基本不可靠**:`down()` 通常从没被执行过，删列还会丢数据。所以唯一稳的策略是 expand-contract——本次只加列/加表（旧代码照样跑），删列/改语义放到下一个发布，这样回滚永远不动 DB。回滚后有三件必做而最常被忘的:重置 opcache、重建旧 release 的框架缓存（`bootstrap/cache/config.php` 可能是上一次 build 的、也可能根本不存在）、queue:restart 让 worker 回到旧代码。

> ⚠️ **修正（事实核查 1.6）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：把 realpath cache 和 opcache 混成一件事了。`opcache_reset()`（cachetool 走的就是它）只清共享内存里的字节码，**不清** 每个 FPM worker 进程各自的 realpath cache；realpath cache 由 `realpath_cache_ttl`（默认 120s）自然过期，PHP 里只有进程内的 `clearstatcache(true)` 能清，没有跨进程 API。所以切完 symlink 只做 opcache:reset，worker 仍可能按缓存的旧真实路径解析并命中旧文件 —— 正是该文档自己 pitfall 第 2 条描述的「几秒到两分钟后才自己好」，而 mapping 却把 opcache:reset 说成解药。
>
> **应改为**：把两件事分开写：字节码 → `cachetool opcache:reset`；路径解析 → 只能 `systemctl reload php8.3-fpm`（新 worker 是空 realpath cache，配好 `process_control_timeout` 不丢在途请求），或调低 `realpath_cache_ttl` / 开 `opcache.revalidate_path=1`，或干脆让 DocumentRoot 指向不含 symlink 的真实 release 路径。回滚步骤里 reload 不是「有 preload/Octane 才要」的可选项，而是消除 realpath 窗口的必需项。


#### 8. 只有新版本才有的可观测差异  `[confident]`

```bash
# 1) 构建时把 release id 落盘并暴露（最可靠）
git rev-parse --short HEAD > /var/www/current/public/REVISION
test "$(curl -s https://your.host/REVISION)" = "$(git rev-parse --short HEAD)" && echo WEB_OK
# Laravel: config/app.php 加 'release' => env('APP_RELEASE'),
#          Route::get('/__version', fn() => ['release' => config('app.release')]);
curl -s https://your.host/__version | jq -r .release

# 2) 不改代码的断言：直接问 FPM 的 opcache 里那个文件的时间戳
cachetool opcache:status:scripts --fcgi=/run/php/php8.3-fpm.sock | grep FooService.php
stat -c %Y /var/www/current/app/Services/FooService.php    # macOS: stat -f %m

# 3) 行为断言：只有新版本才有的路由/字段
curl -s -o /dev/null -w '%{http_code}\n' https://your.host/api/new-endpoint   # 旧版 404 → 新版 200
curl -s https://your.host/api/foo | jq -e '.new_field' >/dev/null && echo FIELD_OK

# 4) worker 层必须单独证明（web 生效 ≠ worker 生效）
ps -o lstart=,cmd= -p $(pgrep -f 'artisan queue:work' | head -1)   # 启动时间必须晚于部署时间
# 或投一个 canary job，让它把 config('app.release') 写进日志

# 5) 日志哨兵
grep -c "release=$(git rev-parse --short HEAD)" /var/www/current/storage/logs/laravel.log
```

**说明**：最大的陷阱:用 `php artisan tinker` / `php -r` 验证等于**零证明**。CLI 默认 opcache.enable_cli=0、每次直读磁盘、而且用的是另一份 php.ini（memory_limit、扩展、disable_functions 都可能不同），所以 CLI 永远显示新代码而 FPM 可能还在服务旧字节码。所有 web 断言必须走 HTTP，worker 断言必须看进程启动时间或 canary job，两层分别证明。cachetool 的 scripts 断言最有说服力（直接读 FPM 共享内存里那个文件的编译时间戳），但依赖 socket 可访问且 opcache.restrict_api 没拦，所以我把它标为可选路径而不是主路径。

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

- **把"改了代码要重启"当默认动作照搬到 PHP（或反过来，以为 PHP 一定不用重启）** `[version-dependent]`
  - 为什么：FPM/mod_php 是 share-nothing，代码每请求重新编译，默认 opcache.validate_timestamps=1 + revalidate_freq=2 下改完 2 秒内自动生效——重启纯属多余，还可能因为 process_control_timeout 默认 0 丢掉在途请求。但反过来，validate_timestamps=0、opcache.preload 有值、或 Octane/Swoole/RoadRunner/FrankenPHP worker 模式下，代码永远不会自动生效。更隐蔽的是 `php -r 'opcache_reset();'` 在 CLI 跑对 FPM 完全无效：不同进程、不同共享内存段、还常常是两份不同的 php.ini。
  - 怎么办：先读 FPM（不是 CLI）的 opcache 配置：`cachetool opcache:status --fcgi=/run/php/php8.3-fpm.sock`。默认配置什么都不做；validate_timestamps=0 就 `cachetool opcache:reset --fcgi=...` 或 `sudo systemctl reload php8.3-fpm`（并把 process_control_timeout 设成 10s）；有 preload 或常驻 worker 模式则必须 `systemctl restart php8.3-fpm` / `php artisan octane:reload`。

- **symlink 原子部署切完了，站点还在返回旧代码，几秒到两分钟后才自己好** `[confident]`
  - 为什么：realpath_cache_ttl 默认 120 秒，FPM worker 缓存了 symlink 指向的旧 release 真实路径；opcache.revalidate_path 默认 0 不会重新解析路径，而 opcache 是按 realpath 做 key 的。于是 mtime 检查全部命中旧文件，看起来像"部署没成功"，重试一次又好了，最容易被误判成偶发。
  - 怎么办：切完 symlink 立刻 `cachetool opcache:reset --fcgi=/run/php/php8.3-fpm.sock` 或 reload FPM，把这一步写进部署脚本而不是靠等；或设 opcache.revalidate_path=1（有性能代价）。用 Deployer/Capistrano 而不是手写 `ln -sfn`，它们已经处理了这个顺序。

- **composer 的 authoritative classmap 让新增/改名的类在生产报 "Class not found"，本地一切正常** `[confident]`
  - 为什么：部署里普遍写的 `composer install --no-dev --optimize-autoloader --classmap-authoritative` 会关掉 PSR-4 的文件系统回退——类不在 dump 时扫出来的 classmap 里，autoloader 直接判定它不存在，不会去磁盘找。本地开发用的是非 optimized autoloader，有回退，所以永远复现不出来。顺序错（先 composer install 再同步代码）也会造成同样结果。
  - 怎么办：部署顺序固定为「同步代码 → composer install --no-dev --optimize-autoloader --classmap-authoritative」；本地新增类文件后也跑一次 `composer dump-autoload`；代码评审时把"本次是否新增了类文件"作为触发条件去核对 dump 步骤。

- **改了 Job / Message 的构造函数签名或属性，部署后队列里积压的旧任务全部炸进 failed_jobs** `[confident]`
  - 为什么：Laravel/Symfony 把 job 序列化成 payload 存进队列（SerializesModels 只存模型 id），worker 用【新代码】去反序列化【旧结构】的 payload：少了属性就是 undefined property，构造参数数量变了就是 ArgumentCountError，重试几次直接进 failed_jobs。这就是 PHP 项目里"在途工作"的真实所在，它完全不在 web 层，部署前不看队列根本发现不了——原 playbook 那套 pm2 视角在这里没有对应物。
  - 怎么办：部署前断言队列干净：database 队列 `SELECT COUNT(*) FROM jobs WHERE reserved_at IS NOT NULL` = 0 且积压为 0，redis 队列 `ZCARD queues:default:reserved` = 0。改签名时不要改老类，新建一个 Job 类、让旧类保留一个发布周期；必须加属性就给默认值并做双读兼容。

- **从开发机 rsync 上去的构建/缓存产物让生产站点整体错乱** `[confident]`
  - 为什么：几个具体后果：public/hot 存在时 Laravel 的 @vite 会把资源 URL 指向 http://localhost:5173，生产打开就是无样式白页；bootstrap/cache/config.php 若是开发机 build 的，会把开发库凭证和绝对路径烧进生产运行时；storage/ 被整体覆盖会丢日志和用户上传；Symfony 的 var/cache/dev 同理。这些都不报错，只是行为不对。
  - 怎么办：部署排除清单固定为 .git、node_modules/、tests/、.env*、public/hot、bootstrap/cache/*.php、storage/（改成 shared 目录软链）、var/。vendor/ 要么在构建机整体产出随包发、要么在目标机 composer install，绝不半新半旧地 rsync。生产只跑 `composer install`（按 composer.lock），永不 `composer update`。

- **拿 `php artisan` / `php -r` 的输出当"新代码已生效"的证据** `[confident]`
  - 为什么：CLI 默认 opcache.enable_cli=0、每次直读磁盘、且用的是与 FPM 不同的 php.ini（memory_limit、扩展、disable_functions 都可能不同）。所以 CLI 永远显示新代码，而 FPM 可能还在服务旧字节码——用 CLI 验证"新版本可观测差异"这一步的结论恒为真，等于没验。同理 config:cache 生成成功不代表 FPM 已经加载了新缓存。另外生产 --no-dev 安装下 laravel/tinker 常常根本不存在，靠 tinker 写的断言脚本会直接失败。
  - 怎么办：web 层断言全部走 HTTP（版本端点比对 git rev-parse、新路由 404→200、新字段存在）；worker 层单独证明（进程启动时间晚于部署时间，或投一个把 release id 写日志的 canary job）；生产断言脚本用 mysql/redis-cli 直查，不依赖 tinker。


## Node.js 后端（CommonJS/ESM × 纯 JS/TypeScript × Express/Nest/Fastify）。实测环境：node v22.23.1 与 v18.20.4（nvm 并存对比）、eslint 9.39.5、typescript 5.9.3、madge 8.0.0、fastify 5；pm2/docker/redis 未在本机安装，相关命令按官方文档给出并已标注未实测。

### 七类动作的命令映射

#### 语法检查  `[version-dependent]`

```bash
# 纯 JS（.js/.mjs/.cjs）
node --check src/app.js
# 只查本次改动（macOS 的 xargs 没有 -r，去掉即可）
git diff --name-only --diff-filter=ACM HEAD | grep -E '\.(js|mjs|cjs)$' | xargs -r -n1 node --check
# 强制按 ESM 解析（不看 package.json；stdin 必须显式指定）
cat src/app.js | node --check --input-type=module

# TypeScript：node --check 不认类型注解，别用
npx tsc --noEmit -p tsconfig.json          # 语法+类型一起（见静态检查那条）
npx esbuild 'src/**/*.ts' --loader:.ts=ts --outdir=/dev/null   # 只要“解析通过”的最快纯语法层
```

**说明**：实测分界线在 node 版本：同一份含 import 的 .js，v22.23.1 `node --check` exit 0（22.7+ 默认开模块语法探测），v18.20.4 直接报 "Cannot use import statement outside a module"。.mjs + 顶层 await 在 18/22 都通过。stdin 不走探测，必须 --input-type=module。`node --check t.ts` 在 22.23 报 SyntaxError: Missing initializer in const declaration，**加 --experimental-strip-types 也一样报** —— TS 的语法层只能靠 tsc/esbuild/swc。

> ⚠️ **修正（事实核查 1.5）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：这条命令跑不起来，两处都不成立：(a) esbuild 不做 glob 展开（官方明确说交给 shell），加了引号后 `src/**/*.ts` 被当字面路径，直接 "could not resolve"；(b) `--outdir=/dev/null` 会让 esbuild 尝试在 /dev/null 下建目录写文件，ENOTDIR 失败。于是「最快纯语法层」在真实项目里必然报错，容易被误读成「语法有问题」。
>
> **应改为**：要么去掉引号让 shell 展开并给真目录：`npx esbuild src/**/*.ts --outdir="$(mktemp -d)"`（bash 需 `shopt -s globstar`，zsh 原生支持；`--loader:.ts=ts` 对 .ts 文件是多余的），要么逐文件走 stdin：`node -e '...'` 配 `esbuild --loader=ts < f.ts > /dev/null`。更稳的是这条自己写的 `tsc --noEmit`，纯语法层用 esbuild 不值得多这一层坑。


#### 静态检查  `[confident]`

```bash
npm i -D eslint@9 @eslint/js globals
cat > eslint.config.mjs <<'EOF'
import js from "@eslint/js";
import globals from "globals";
export default [
  js.configs.recommended,
  { files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",          // 纯 CJS 项目改成 "commonjs"
      globals: { ...globals.node }   // 不写这行，process/require/__dirname 会被 no-undef 误报
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-undef": "error",                                   // ≈ pyflakes F821
      "no-unused-vars": ["error", { args: "after-used", varsIgnorePattern: "^_", argsIgnorePattern: "^_" }], // ≈ F401/F841
      "no-redeclare": "error", "no-dupe-keys": "error",
      "no-unreachable": "error", "no-const-assign": "error",
      "require-atomic-updates": "error"
    } }
];
EOF
npx eslint . --max-warnings=0            # 有问题 exit 1

# TS 项目：按 typescript-eslint 官方建议关掉 no-undef（tsc 管未定义名），未用变量换插件版
npm i -D typescript-eslint
#   rules: { "no-undef": "off", "@typescript-eslint/no-unused-vars": ["error", {argsIgnorePattern:"^_"}] }
```

**说明**：实测 eslint 9.39.5 对一段 4 行代码一次抓出 4 条：未用 import(`'path' is defined but never used`)、未用变量、未用形参、未定义名(`'typoFunction' is not defined`)——正好覆盖 pyflakes 那层“改动过程中自己新引入的 bug”。三个必须做对的点：globals.node 不写就全是误报；sourceType 必须和真实模块体系一致（CJS 写成 module 会解析错 require）；TS 下开着 no-undef 会对类型名和全局误报，必须关。补一层 import 解析：`npm i -D eslint-plugin-import` 开 `import/no-unresolved` + `import/named`，能抓到 pyflakes 抓不到的“路径写错/命名导出不存在”。

#### 静态检查  `[confident]`

```bash
npx tsc --noEmit -p tsconfig.json          # 有错 exit 2
# tsconfig 里这两项不开，tsc 不报未用变量：
#   "noUnusedLocals": true, "noUnusedParameters": true

# 关心哪几类错就 grep：TS2304 未定义名 / TS6133 未用 / TS2339 属性不存在 / TS7006 隐式 any
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'TS2304|TS6133|TS2339|TS7006'

# 确认你改的文件真的在检查范围内（不在 include 里会静默漏过）
npx tsc --noEmit -p tsconfig.json --listFiles | grep -F src/你改的文件.ts

# 纯 JS 项目也能白拿这一层，不用改成 .ts
npx tsc --noEmit --allowJs --checkJs --skipLibCheck --target ES2022 --module NodeNext src/*.js
```

**说明**：实测 tsc 5.9.3：TS2304 = "Cannot find name 'typoFn'"（未定义名），TS6133 = 未用变量/形参，但**关掉 noUnusedLocals/noUnusedParameters 后同一文件只剩 TS2304**，未用变量整类消失。tsc 在 Node 栈里的位置 = pyflakes + mypy 合体，是最能抓“改一半忘了改另一半”的一层，应该是 CI 的硬门禁（exit 2）。注意它只看 include 命中的文件，所以 --listFiles 那句值得写进流程。

#### 加载冒烟  `[confident]`

```bash
# CJS：真加载一次 + 立刻退出。PORT=0 让内核分临时端口，永不撞端口
PORT=0 NODE_ENV=test node -e 'require("./src/app.js"); console.log("loaded ok"); process.exit(0)'

# ESM：从 -e 的 CJS 上下文动态 import（相对路径按 cwd 解析）
PORT=0 node -e 'import("./src/app.js").then(()=>{console.log("loaded ok");process.exit(0)},e=>{console.error(e);process.exit(1)})'

# ESM + 顶层 await 写法
PORT=0 node --input-type=module -e 'await import("./src/app.js"); console.log("loaded ok")'

# 直接加载 TS 源码（22.6+ 实验；有 enum/装饰器要换 --experimental-transform-types）
PORT=0 node --experimental-strip-types -e 'import("./src/app.ts").then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})'

# CJS 循环依赖不会抛错 —— 必须真调一次导出才暴露
node -e 'const m=require("./src/app.js"); if(typeof m.createApp!=="function"){console.error("half-initialized, exports =",Object.keys(m));process.exit(1)}'

# 静态查环（有环 exit 1，实测）
npx madge --circular --extensions ts,js,mjs,cjs src
```

**说明**：实测 v22.23：process.exit(0) 会连已 listen 的 server 一起立刻退出，所以「PORT=0 + exit(0)」就是“真加载入口、但不卡住不占端口”的正解。循环依赖两种模块体系差异极大（实测）：CJS 版互 require 全程 **exit 0**，只打一句 `Warning: Accessing non-existent property 'fromA' of module exports inside circular dependency` 并拿到 undefined；同结构 ESM 版直接 `ReferenceError: Cannot access 'fromA' before initialization` 非零退出。madge 实测：有环 exit 1、干净 exit 0，TS 也能扫。

#### 加载冒烟  `[version-dependent]`

```bash
# Fastify：ready() 走完插件树/hook/路由注册，全程不 listen（实测通过）
node --input-type=module -e 'const a=(await import("./src/app.js")).build(); await a.ready(); console.log(a.printRoutes()); await a.close(); console.log("fastify smoke ok")'

# Nest：create + init + close 会把整张 DI 图实例化，专抓 "Nest can't resolve dependencies of X"
node -e 'const {NestFactory}=require("@nestjs/core");const {AppModule}=require("./dist/app.module");NestFactory.create(AppModule,{logger:false}).then(a=>a.init()).then(a=>a.close()).then(()=>{console.log("DI graph ok");process.exit(0)},e=>{console.error(e.message);process.exit(1)})'

# Express：没有 ready 钩子，唯一可靠做法是结构上拆开
#   src/app.js    -> const app=express(); ...挂路由...; module.exports=app     (不 listen)
#   src/server.js -> require("./app").listen(process.env.PORT)                (只有它 listen)
node -e 'const app=require("./src/app.js"); console.log("loaded, routes:",(app._router?.stack||app.router?.stack||[]).filter(l=>l.route).map(l=>Object.keys(l.route.methods)[0]+" "+l.route.path)); process.exit(0)'
```

**说明**：Fastify 那段是本地实测：`await app.ready()` 打出完整路由树后 close，从未绑端口 —— 它等价于“加载 + 装配全验一遍”，是三个框架里最值钱的冒烟层。Nest 的 create()/init() 不绑端口、只有 listen() 才绑，DI 错误全在这一步暴露（文档行为，本机未装 Nest 未实测）。Express 那句用的 `app._router.stack` 是私有字段且 **Express 4 叫 _router、5 起叫 app.router**，只当人工排查用，别写进 CI 断言 —— Express 的正解是靠拆 app/server 文件而不是靠探测。

#### 逻辑验证  `[version-dependent]`

```bash
# 内置 runner（node 20+ 稳定）
node --test test/
node --test --experimental-strip-types 'test/**/*.test.ts'      # 22.6+

# prod 本来就是 sqlite 才用内存库（22.5+，实测可用但有 ExperimentalWarning）
node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(":memory:");db.exec("create table t(a)");console.log("ok")'

# prod 是 PG/MySQL：不要换引擎。起一次性容器
npm i -D testcontainers @testcontainers/postgresql        # 需要本机 docker daemon
# 或者同引擎开一次性库，跑完 drop
DB=app_smoke_$$; createdb $DB && DATABASE_URL="postgres://u:p@127.0.0.1:5432/$DB" npx prisma migrate deploy \
  && DATABASE_URL="postgres://u:p@127.0.0.1:5432/$DB" node --test test/ ; dropdb $DB
# 每个用例包在事务里：await c.query('BEGIN') ... await c.query('ROLLBACK')  → 零残留

# 硬断“绝不乱写盘”（实测越界写报 ERR_ACCESS_DENIED）
node --permission --allow-fs-read='*' --allow-fs-write='/tmp/smoke' --test test/

# 掐断出网（--permission 管不了网络，必须靠这个）
npm i -D undici nock
# const {MockAgent,setGlobalDispatcher}=require('undici');
# const a=new MockAgent(); a.disableNetConnect(); setGlobalDispatcher(a);   // fetch/undici 全局兜住
```

**说明**：实测差异：`node:sqlite` 在 v22.23 可用、v18.20.4 直接 ERR_UNKNOWN_BUILTIN_MODULE；`--permission` 在 22 上与 `--experimental-permission` 都接受，18 上两个都是 "bad option"。**关键诚实提醒：权限模型只覆盖 fs/child_process/worker_threads/addon，不覆盖网络** —— 实测 --permission 下 net.connect 照样出去，所以“零不可逆副作用”里的“不发真请求”只能靠 MockAgent/nock。选内存 sqlite 之前先问一句：prod 是 PG/MySQL 的话 upsert 语法、JSON 函数、类型强制、隔离级别都不同，测过等于白测 —— 宁可用 testcontainers 或同引擎一次性库。

#### 部署后是否需要重启  `[version-dependent]`

```bash
# 事实：Node 把模块图缓存在进程内存（require.cache / ESM registry 都不重读），
# 改完文件不重启 = 100% 还在跑旧代码。和 PHP 每请求重读完全相反。

# pm2（指名，不要 restart all）
pm2 restart api --update-env       # 改了 .env / ecosystem 的 env 必须带 --update-env
pm2 reload api                     # 只有 cluster 模式才是滚动无损；fork 模式等于 restart
pm2 startOrReload ecosystem.config.js --only api --update-env
pm2 describe api | head -25 && pm2 save    # 不 save，机器重启后 resurrect 会拉回旧定义

# systemd
sudo systemctl restart api.service
systemctl show api.service -p MainPID -p ActiveState -p NRestarts -p ExecMainStartTimestamp
sudo journalctl -u api.service -n 50 --no-pager

# docker / compose（代码 COPY 进镜像的话，只 restart 容器 = 跑旧镜像）
docker compose up -d --build api          # 只动这一个 service
docker compose restart api                # 仅当源码是 bind mount 才有意义
docker inspect -f '{{.State.StartedAt}} {{.Config.Image}}' api
```

**说明**：唯一例外是显式开了热重载（node --watch / nodemon / ts-node-dev），那是开发态，生产别开。最常踩的是 docker 那条：`docker compose restart` 不重建镜像。pm2 侧字段与 --update-env 行为按 pm2 v5/v6 文档，本机未装 pm2 未实测，故标 version-dependent。任何一种重启完都必须再跑一遍下面“可观测差异”那条断言，不要信命令 exit 0。

#### 部署后是否需要重启  `[version-dependent]`

```bash
# 重启前先断言“现在有什么在途”

# 0) 这个进程还挂着哪些句柄（实测输出形如 [ 'TCPServerWrap', 'Timeout' ]）
node -e 'console.log(process.getActiveResourcesInfo())'   # 线上要在应用里暴露成 /debug 端点才看得到

# 1) HTTP 在途连接（含 SSE / chunked 长连接）
ss -tnp state established "( sport = :8010 )" | wc -l      # Linux
lsof -nP -iTCP:8010 -sTCP:ESTABLISHED                       # macOS
# 应用内更准：server.getConnections((e,n)=>...) 塞进 /healthz

# 2) BullMQ：active > 0 就是有 job 正在跑
node -e 'const {Queue}=require("bullmq");const q=new Queue("mailer",{connection:{host:"127.0.0.1",port:6379}});q.getJobCounts("active","waiting","delayed","failed").then(c=>{console.log(c);process.exit(c.active>0?1:0)})'
redis-cli LLEN bull:mailer:active; redis-cli LLEN bull:mailer:wait

# 3) Agenda（Mongo）
mongosh "$MONGO_URL" --quiet --eval 'db.agendaJobs.countDocuments({lockedAt:{$ne:null},lastFinishedAt:null})'

# 4) 优雅停机自检：进程到底有没有装 SIGTERM 处理
node -e 'require("./src/server.js"); setImmediate(()=>{console.log("SIGTERM listeners:",process.listenerCount("SIGTERM"));process.exit(0)})'
```

**说明**：三条硬事实决定断言怎么写：(a) setInterval/setTimeout/node-cron 是纯内存态，重启即丢且不补跑，要“不丢”只能外部 cron 或持久化队列；(b) BullMQ 是 at-least-once —— 进程被杀时 active 的 job 会变 stalled，约 stalledInterval(默认 30s) 后重派，maxStalledCount 用尽才算 failed，所以 handler 必须幂等，“重启不丢”≠“重启不重复”；(c) server.close() 只停 accept、会等在途请求结束，但 keep-alive 空闲连接会把它吊住，要配 server.closeIdleConnections()（Node 18.2+，实测 22 上 close/closeIdleConnections/closeAllConnections 三个都在）。SSE、长轮询、大文件下载属于“必然被打断”，只能靠客户端重连。BullMQ 的 redis key 布局是内部实现、跨版本可能变，getJobCounts API 才是稳的。pm2 默认 kill-timeout 约 1.6s、systemd TimeoutStopSec 默认 90s、docker stop 默认 10s，超时就 SIGKILL —— 排空时间超过这个值必须显式调大。

#### 回滚  `[version-dependent]`

```bash
# 代码 + 依赖 + 产物必须一起回，只回代码 = 半新半旧
git -C /srv/api checkout <prev-sha>
npm ci --omit=dev            # 用目标 commit 的 lockfile 严格重装；npm install 会改 lockfile，别用
npx prisma generate          # 生成物（prisma client / proto / codegen）必须重跑
npm run build                # TS：dist 是产物，回了 src 不等于回了 dist
pm2 restart api --update-env

# 更稳的形态：release 目录 + 原子切软链（GNU coreutils；macOS/BSD 用 mv -h）
ln -sfn /srv/releases/<prev-ts> /srv/current.new && mv -Tf /srv/current.new /srv/current && pm2 restart api

# pm2 自带 deploy 子系统
pm2 deploy ecosystem.config.js production revert 1

# docker：按 digest 回，别按 :latest
IMAGE_TAG=<prev-digest> docker compose up -d --force-recreate --no-build api

# 迁移单独考虑：代码回滚 ≠ schema 回滚
npx typeorm migration:revert        # 一次只退一个
npx knex migrate:down               # 或 migrate:rollback 退一整批
npx sequelize-cli db:migrate:undo
# Prisma 没有 down migration：只能 prisma migrate resolve --rolled-back <name> 再写一个前向迁移
```

**说明**：Node 侧回滚最容易漏三件事：**lockfile**（只有 npm ci 和 lockfile 严格一致）、**native 模块 ABI**（better-sqlite3 / bcrypt / sharp 跨 node 大版本要 npm rebuild，否则报 NODE_MODULE_VERSION 不匹配）、**dist 与 src 不同步**（回了源码忘重 build，跑的还是新 dist）。所以回滚的正确单位是“整个 release 目录 + 它自己的 node_modules”，不是 git revert 一把。schema 层建议 expand-contract（先加不删、两版兼容），否则代码能回、数据回不去 —— Prisma 用户尤其要注意，它根本没有 down migration。pm2 deploy / mv -Tf 语法按各自文档，未在本机实测。

#### 新版本可观测差异  `[version-dependent]`

```bash
# 首选：把 sha 编进进程，启动打一行 + 暴露端点
#   构建期注入 GIT_SHA=$(git rev-parse HEAD) 到 .env / ecosystem env / --define
#   app.get('/healthz',(q,r)=>r.json({sha:process.env.GIT_SHA,pid:process.pid,uptime:process.uptime()}))
test "$(curl -fsS localhost:8010/healthz | jq -r .sha)" = "$(git -C /srv/api rev-parse HEAD)" && echo NEW || echo STILL-OLD

# 不改应用也能断言：任何部署文件比进程启动时间更新 = 在跑旧代码（GNU date/find，Linux OK）
PID=$(pm2 pid api); START=$(date -d "$(ps -o lstart= -p $PID)" +%s)
find /srv/api/dist /srv/api/src -type f -newermt "@$START" -print -quit    # 有输出就是旧进程

# pid / 重启计数必须变
pm2 jlist | jq '.[]|select(.name=="api")|{pid,restarts:.pm2_env.restart_time,up:.pm2_env.pm_uptime,status:.pm2_env.status}'
systemctl show api.service -p MainPID -p NRestarts -p ExecMainStartTimestamp
docker inspect -f '{{.State.StartedAt}} {{index .RepoDigests 0}}' api

# 行为探针：只有新版本才有的字段/路由/日志行，且要绕缓存
curl -fsS -H 'Cache-Control: no-cache' "localhost:8010/api/thing?cb=$(date +%s)" | jq 'has("newFieldOnlyInNewVersion")'
pm2 logs api --lines 100 --nostream | grep -F "boot sha=$(git -C /srv/api rev-parse --short HEAD)"
```

**说明**：反面教材：只 curl 一个业务接口看返回变了就宣布上线成功。中间可能有 CDN / nginx proxy_cache / 进程内 memo / 客户端缓存；更阴的是 pm2 cluster 滚动 reload 期间新旧 worker 同时在跑，单次 curl 可能命中任一边 —— 探针要打足够多次，或逐个 instance 看 pid。最强的两个断言是「pid 变了」和「没有任何部署文件比进程启动时间更新」，因为它们完全不依赖应用配合。`date -d` 和 `find -newermt` 是 GNU 写法（Linux 服务器可用，macOS 需 coreutils）；pm2 jlist 字段名按 pm2 v5/v6 文档，本机未装 pm2 未实测。

> ⚠️ **修正（事实核查 1.10）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：`RepoDigests` 是**镜像**的字段，容器 inspect 的 JSON 里没有它。这条模板对容器执行会直接报 `map has no entry for key "RepoDigests"`（或输出 <no value>），拿不到任何证据 —— 而它正是「证明跑的是新镜像」这一层的关键断言。注意同一份文档前面 `docker inspect -f '{{.State.StartedAt}} {{.Config.Image}}' api` 是对的，只有这一处越界。
>
> **应改为**：分两步：`ID=$(docker inspect -f '{{.Image}}' api)` 拿到容器实际运行的镜像 sha256，再 `docker image inspect -f '{{index .RepoDigests 0}}' "$ID"`；或直接断言 `{{.Image}}` 与 `docker image inspect -f '{{.Id}}' <期望 tag>` 相等（这条比 digest 更能抓「tag 没变但镜像重建了」）。


### 本栈审查维度重点清单（替换 playbook 里 DIMS 的 focus）

- CJS/ESM 边界一致性：package.json 的 type 与 exports 字段、.mjs/.cjs 扩展名、ESM 里还在用 __dirname/require（应为 import.meta.dirname，Node 20.11+）、对 ESM-only 包用 require（Node 22.12 前抛 ERR_REQUIRE_ESM）

- async 错误路径：漏写的 await（浮空 promise 静默丢错）、Promise.all 一个 reject 拖垮整体、Express 4 里 async handler 抛错不进 error middleware（需 wrapper 或升 Express 5）、有没有 unhandledRejection 兜底（Node 15+ 默认让进程退出）

- 事件循环阻塞（Python 多 worker 下不明显、Node 单线程会拖垮整个进程）：readFileSync、大 body 的 JSON.parse、同步 crypto/zlib、可回溯爆炸的正则、循环里 await 串行化

- 类型边界的真实性：as / any / 非空断言把检查糊过去；req.body、process.env、第三方响应有没有运行时校验（zod/valibot）；tsconfig 的 strict / noUncheckedIndexedAccess 是否被关掉

- 资源与句柄泄漏（常驻进程会累积）：setInterval 没 clearInterval 也没 unref()、DB 连接池不关、stream/fs.watch 不销毁、EventEmitter MaxListeners 警告

- 停机与幂等：有没有 SIGTERM/SIGINT handler，handler 里是否 server.close() + closeIdleConnections() + 关连接池 + worker.close()；队列 handler 是否幂等（BullMQ 是 at-least-once，重启会重派）

- 依赖与产物一致性：lockfile 是否随 package.json 同提交、runtime 代码有没有 require 到 devDependency、dist 是否由本次 build 产生、engines.node/.nvmrc 与服务器 node -v 一致、native 模块是否需要 npm rebuild

- 副作用位置：模块顶层有没有连库/读文件/发请求/app.listen()/注册定时器；配置读取是否发生在 import 期（会让测试和冒烟被迫连生产）

### 本栈特有的坑

- **CJS 循环依赖“静默通过”，加载冒烟给出假绿灯；同样结构在 ESM 下却是硬崩** `[confident]`
  - 为什么：实测 v22.23：a.cjs ↔ b.cjs 互 require，进程 **exit 0**，只打一句 `Warning: Accessing non-existent property 'fromA' of module exports inside circular dependency`，拿到的是 undefined —— 半初始化的模块被当成加载成功。同结构写成 .mjs 直接 `ReferenceError: Cannot access 'fromA' before initialization` 非零退出。也就是说“加载冒烟能抓循环依赖”这句话只对 ESM 成立。
  - 怎么办：CJS 项目的冒烟不能只 `node -e 'require("./src/app.js")'`，必须真调一次关键导出并断言类型：`node -e 'const m=require("./src/app.js"); if(typeof m.createApp!=="function"){console.error(Object.keys(m));process.exit(1)}'`；再加静态门禁 `npx madge --circular --extensions ts,js,cjs,mjs src`（实测有环 exit 1、干净 exit 0）。

- **`node --check` 给的是版本相关的假安全感，TS 上直接不可用** `[confident]`
  - 为什么：实测同一份含 `import` 的 .js：v22.23.1 exit 0（22.7+ 默认开模块语法探测），v18.20.4 报 "Cannot use import statement outside a module"。stdin 不走探测（必须 --input-type=module）。`node --check t.ts` 在 22.23 报 `SyntaxError: Missing initializer in const declaration`，**加 --experimental-strip-types 依然报**。于是“本地 --check 过了”在另一台 node 版本不同的机器上可能是反的结论。
  - 怎么办：语法层按文件类型分流并锁 node 版本：.mjs/.cjs 用 `node --check`；.js 用 `node --check` 且 CI 与服务器 node 大版本一致；.ts 跳过 --check，直接 `npx tsc --noEmit -p tsconfig.json` 或 `npx esbuild 'src/**/*.ts' --loader:.ts=ts --outdir=/dev/null`。

- **TS 检查全绿 ≠ 运行时对：类型擦除会吃掉运行时真正需要的东西** `[confident]`
  - 为什么：三个实测/已知点：(1) `--experimental-strip-types` 遇到 enum 直接 `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode`（实测），要 `--experimental-transform-types`；(2) `import type` / `verbatimModuleSyntax` 下装饰器元数据被擦，Nest 的构造函数注入会拿到 undefined，而 tsc 一句不报；(3) 实测 `module: NodeNext` + `verbatimModuleSyntax` 时，最近的 package.json 少写一行 `"type":"module"` 就让 .ts 被当 CJS，`export` 报 TS1287 —— 同一份代码两台机器结论不同，差的往往就是那一行。
  - 怎么办：TS 项目的加载冒烟必须跑真实运行形态：`npm run build && node -e 'require("./dist/main.js")'`，或用项目自己的 loader（tsx / ts-node / 框架 CLI）。不要拿裸 `node --experimental-strip-types` 的结果代表生产行为。Nest 项目额外把「create + init + close 走通 DI 图」作为固定冒烟步骤。

- **顶层副作用让“冒烟”变成“打生产”** `[confident]`
  - 为什么：Node 入口普遍在模块顶层就 `dotenv.config()`、建连接池、注册定时任务、`app.listen()`。一句 require/import 就可能连上生产库、发真请求、抢占端口。`PORT=0` 只解决端口冲突（实测有效），解决不了连库和外发请求。
  - 怎么办：结构上拆：`src/app.js` 只组装并导出 app，`src/server.js` 才 listen，冒烟只加载 app 层；跑冒烟时 `NODE_ENV=test` + DATABASE_URL 指向一次性库 + `--permission --allow-fs-read='*' --allow-fs-write=/tmp/smoke`（实测越界写报 ERR_ACCESS_DENIED）。但注意权限模型不管网络（实测 --permission 下 net.connect 照样出去），断网必须用 undici MockAgent 的 `disableNetConnect()` 或 nock。

- **pm2 / docker 的三种安静失败：命令 exit 0，但跑的还是旧代码或旧配置** `[version-dependent]`
  - 为什么：(1) 不带 `--update-env` 重启，改过的 .env / ecosystem env 不生效，进程继续用旧环境变量；(2) `pm2 reload` 只有 cluster 模式是滚动无损，fork 模式等于一次硬重启（还会中断在途请求）；(3) 改完不 `pm2 save`，机器重启后 resurrect 拉回旧的进程定义；(4) docker 侧对应的是 `docker compose restart` 不重建镜像 —— 代码是 COPY 进镜像的话，重启一百次仍是旧代码。
  - 怎么办：固定成一串：`pm2 restart api --update-env && pm2 save && pm2 describe api`；docker 固定 `docker compose up -d --build api`。然后**强制**跑一遍“新版本可观测差异”断言（sha 端点比对，或 `find … -newermt "@$进程启动时间"` 无输出），把“命令成功”和“新代码生效”当两件事验。

- **node 版本漂移让整套命令的结论翻转** `[confident]`
  - 为什么：实测同一批命令在 v18.20.4 与 v22.23.1 上结果不同：`require("node:sqlite")` 18 上 ERR_UNKNOWN_BUILTIN_MODULE、22 上可用（带 ExperimentalWarning）；`--permission` 18 上 "bad option"、22 上和 `--experimental-permission` 都接受；.js 里的 ESM 语法探测只有 22.7+ 默认开；`require()` ESM 图要到 22.12+ 才不抛 ERR_REQUIRE_ESM。“本地能跑、服务器炸”的一大半来源就是这个。
  - 怎么办：仓库放 `.nvmrc` + package.json `engines.node`，本地/CI/服务器三处 `node -v` 对齐；部署脚本第一行加断言：`node -e 'const [M,m]=process.versions.node.split(".").map(Number); if(M<22||(M===22&&m<12)){console.error("need node>=22.12, got",process.versions.node);process.exit(1)}'`。playbook 里每条命令都标清它依赖的最低 node 版本。


## 纯 HTML / jQuery 前端，无构建步骤（.html/.js/.css 直接上传，无 webpack/vite/npm run build）

### 七类动作的命令映射

#### 1. 语法检查  `[confident]`

```bash
# 在站点根目录跑。逐个 .js 过一遍 JS 解析器（本栈唯一「零配置」门禁）
find . -name '*.js' ! -path '*/vendor/*' ! -path '*/node_modules/*' ! -name '*.min.js' -print0 \
| xargs -0 -n1 -I{} sh -c 'node --check "{}" >/dev/null 2>&1 || { echo "SYNTAX FAIL: {}"; node --check "{}" 2>&1 | sed -n "2,5p"; }'

# 要非零退出码当 CI/部署门禁（实测 xargs 退出码 = 1）：
find . -name '*.js' ! -path '*/vendor/*' ! -name '*.min.js' -print0 | xargs -0 -n1 node --check
```

**说明**：对应原文「语法」层，且是本栈**唯一**天然存在的门禁——没有构建，语法错误否则直接进生产（浏览器只在 console 里静默报一次，页面白屏）。
实测边界（务必知道）：`node --check` 对 `$(function(){ conosle.log(a) })` 判 PASS——它**完全不做名字检查**，拼错的全局、忘加载的库一个都抓不到。所以这层只证明「没打错括号」，静态层不能省。
另：node ≥22.7 会自动按 ESM 重解析，`import/export`、顶层 await 都判 PASS（实测），旧 node 会 FAIL——别用它反推「这文件能不能当普通 <script> 加载」。

> ⚠️ **修正（事实核查 1.9）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：对多页站（本栈的常态：好几个 .html）这条必然假阳性。`*.html` 把所有页面的 script 混成一个列表，既不去重也不按页分组：同一个 `js/common.js` 被 5 个页面引用就会被 cat 进 bundle 5 次，于是它里面每个顶层 `let/const/class/function` 都变成「重复声明」，`node --check` 必报错（本机实测重复 `let` 确实非零退出）；反过来只在 A 页和只在 B 页加载的两个文件也会被判成冲突，而浏览器里它们从不共存。顺序也不是任何一个页面的真实顺序。
>
> **应改为**：按页各自拼一份并去重：对每个 `page.html` 单独提取 src（保持出现顺序、`awk '!seen[$0]++'` 去重）生成 `/tmp/_bundle.<page>.js` 再 `node --check`，任一页失败即失败。文档里要写明「这条是按页而不是按站」，并保留文件间插 `;\n` 的要求。


#### 1. 语法检查（本栈特有：跨文件全局作用域）  `[confident]`

```bash
# 浏览器里所有非 module 脚本共享**一个**全局作用域，逐文件检查看不到冲突。
# 按 <script src> 的真实顺序拼成一个 program 再解析一次：
grep -ohE '<script[^>]+src="[^"]+"' *.html | sed -E 's/.*src="([^"]+)".*/\1/' \
  | grep -vE '^(https?:)?//' | sed 's/?.*//;s#^/##' > /tmp/_order.txt
: > /tmp/_bundle.js
while read -r f; do [ -f "$f" ] && { cat "$f"; echo ';'; } >> /tmp/_bundle.js; done < /tmp/_order.txt
node --check /tmp/_bundle.js

# var 重复声明是合法 JS，解析器永远不报 → 只能靠顶层声明清单比对：
grep -rnE '^(var|let|const|class|function|async function) [A-Za-z_$][A-Za-z0-9_$]*' --include='*.js' . \
 | grep -vE '/vendor/|\.min\.js' \
 | sed -E 's/^(.*):([0-9]+):(var|let|const|class|function|async function) +([A-Za-z0-9_$]+).*/\4\t\1:\2/' \
 | sort | awk -F'\t' '{n[$1]=n[$1]" "$2;c[$1]++} END{for(k in c) if(c[k]>1) printf "冲突 %-14s ->%s\n",k,n[k]}'
```

**说明**：这条在原 playbook 里没有对应层——因为 Python/Vue3 有模块作用域，本栈没有。
实测：拼接后 `node --check` 抓到了跨文件 `let SHARED` 重复声明（浏览器里这会让**整个后加载的脚本块 SyntaxError 失效**，前面的代码却已跑过，症状是「一半功能没了、只有一行 console 报错」）。`var cfg` 冲突拼接后仍判 PASS，所以必须配那条清单比对——实测两个文件的 `var cfg` 被列了出来。
拼接时**必须**在文件之间插 `;\n`：浏览器里每个 <script> 是独立 program，ASI 不会跨文件生效，不插分号会改变语义（不一定报错，更坏）。
清单比对是行首锚定的 grep：只覆盖「列 0 的顶层声明」（正是本栈的风险形态），缩进的顶层代码和模板字符串里的伪命中要人眼过一遍。

#### 2. 静态检查  `[version-dependent]`

```bash
npm i -D eslint globals      # 只在本地/CI 存在，不进部署产物；package.json 别传上服务器
cat > eslint.config.js <<'EOF'
const globals = require('globals')
module.exports = [
  { ignores: ['**/vendor/**', '**/*.min.js', 'node_modules/**', 'eslint.config.js'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',                       // 关键：不是 module，顶层就是全局作用域
      globals: { ...globals.browser, ...globals.jquery },   // $ / jQuery / window / document 不再误报
    },
    rules: {
      'no-undef': 'error',                        // ← 本栈最高性价比的一条
      'no-unused-vars': ['error', { args: 'none' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error', 'no-dupe-args': 'error', 'no-dupe-else-if': 'error',
      'no-cond-assign': 'error', 'no-unsafe-negation': 'error', 'no-self-assign': 'error',
      'no-fallthrough': 'error', 'no-sparse-arrays': 'error', 'no-unreachable': 'error',
      'no-implicit-globals': 'warn',              // 本栈核心风险，但老代码会刷屏 → 先 warn
    },
  },
]
EOF
npx eslint . && echo '静态检查干净'

# 全站太脏时，先只守住本次改动的文件（这才是原文「抓自己新引入的 bug」那层）：
npx eslint $(git diff --name-only HEAD | grep '\.js$')

# 项目里还有 CDN 引的库（moment/lodash/bootstrap 等），把它们加进 globals 否则 no-undef 误报：
#   globals: { ...globals.browser, ...globals.jquery, moment: 'readonly', _: 'readonly', bootstrap: 'readonly' }
```

**说明**：这就是原文 §4「静态层最常抓到改动过程中自己新引入的 bug」的等价物，也是本栈**没有构建之后唯一还剩的实质门禁**。
实测：这套配置抓到了 `conosle.log`（`no-undef`）——正是原文 pyflakes 案例的同类，语法检查查不出、没测试就直接漏到线上。
三个必须做对的点，做错这层就等于没跑：① `sourceType: 'script'`（写成 module 会把顶层 var 当模块局部，`no-implicit-globals` 整条失效）；② 必须 ignore `vendor/**` 和 `*.min.js`（压缩过的 jquery 会刷出几百条，真问题被淹——正是原文「自加门禁误报代价比不加更大」）；③ 必须喂 jquery globals，否则每个 `$` 都是 no-undef，人会直接把这条规则关掉。
覆盖不到的：**HTML 里的内联 `<script>` 和 `onclick=""` 属性 ESLint 默认不看**。本栈内联脚本很多，要么装 `eslint-plugin-html` / `@html-eslint`，要么在交接里明说「内联脚本未做静态检查」。

#### 2. 静态检查（HTML 与资源引用层）  `[version-dependent]`

```bash
# a) HTML 结构：重复 id 和未闭合标签会**静默**毁掉 $('#x') 与 .html() 的插入位置
npm i -D html-validate
cat > .htmlvalidate.json <<'EOF'
{ "extends": ["html-validate:recommended"],
  "rules": { "doctype-style": "off", "no-implicit-button-type": "off",
             "no-implicit-input-type": "off", "require-sri": "off" } }
EOF
npx html-validate '**/*.html'

# b) HTML 引用的本地 js/css 是否真的存在（写错路径 = 生产 404 = 白屏，无构建无人拦）
grep -rhoE '(src|href)="[^"]+"' --include='*.html' . | sed -E 's/.*="([^"]+)".*/\1/' \
 | grep -vE '^(https?:)?//|^data:|^mailto:|^#|^javascript:' \
 | sed 's/?.*//;s/#.*//;s#^/##' | sort -u \
 | while read -r p; do [ -f "$p" ] || echo "MISSING: $p"; done
```

**说明**：实测 html-validate 抓到了 `Duplicate ID "row"`（no-dup-id）和 `Unclosed element '<div>'`（close-order）——这两个正是 jQuery 栈里最阴的 HTML 缺陷：`$('#row')` 只返回第一个，第二个永远拿不到；未闭合的 div 让浏览器的纠错结构与你写的不一样，`.append()` 落到别的父节点里。两者都不报错、不影响「页面看起来正常」。
关掉的四条是纯风格（`doctype-style` 要求大写 DOCTYPE 等），留着会淹掉真问题。
(b) 段实测抓到 `MISSING: css/missing.css` / `js/nothere.js`。**这条比 (a) 更该先跑**：本栈重命名/删文件时忘改 HTML 是最高频事故，且症状是整块功能消失而非报错。
注意 html-validate 的规则名与默认集会随大版本变（本次为已装版本实测），升级后先跑一次看有没有新规则刷屏。

#### 3. 加载冒烟  `[version-dependent]`

```bash
npm i -D jsdom
cat > smoke.js <<'EOF'
const { JSDOM, VirtualConsole } = require('jsdom')
const path = require('path'), fs = require('fs')
const entry = process.argv[2]
const expect = process.argv.slice(3)          // 加载完必须存在的全局名
const errs = []
const vc = new VirtualConsole()
vc.on('jsdomError', e => errs.push('jsdomError: ' + (e.message || e)))
vc.on('error', (...a) => errs.push('console.error: ' + a.join(' ')))
const dom = new JSDOM(fs.readFileSync(entry, 'utf8'), {
  url: 'file://' + path.resolve(entry),
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
})
dom.window.addEventListener('error', e => errs.push('window.onerror: ' + e.message))
setTimeout(() => {
  for (const g of expect) if (typeof dom.window[g] === 'undefined') errs.push('缺失全局: ' + g)
  if (errs.length) { console.error('加载冒烟 FAIL'); errs.forEach(e => console.error('  - ' + e)); process.exit(1) }
  console.log('加载冒烟 PASS（0 错误，全局齐全: ' + expect.join(', ') + '）'); process.exit(0)
}, 1500)
EOF
node smoke.js index.html jQuery APP_BUILD initApp

# 真浏览器版（jsdom 报错就用它复核，这是 ground truth）：
# 用会话里的浏览器工具打开页面 → read_console_messages(onlyErrors:true) 断言为空
#   + javascript_tool 里跑：[typeof jQuery, typeof initApp, window.APP_BUILD]
```

**说明**：对应原文「导入冒烟：真的加载一次入口，验循环依赖、模块级副作用」。本栈没有 import，**等价物是 `<script>` 的加载顺序依赖 + 顶层立即执行代码**。
实测证伪能力（这层能告我）：故意把 app.js 放在 jquery.js 之前，输出 `window.onerror: $ is not defined` + `缺失全局: APP_BUILD, APP_READY`；把顺序调回来后 PASS。顺序修好前后都「构建通过」——因为根本没有构建，这正是原文「编译通过 ≠ 正确」在本栈最锋利的形态。
第二个参数往后列的全局名很重要：只断言「0 错误」会漏掉「脚本 404 了但没人抛错」的情况（404 的 script 标签不产生 JS 错误）。
严守原文反模式：**冒烟只验能否加载**。别在这里加「绑定的事件数必须 == N」之类自造门禁。
jsdom 不是浏览器：无布局、canvas/IntersectionObserver 等缺失，重度用这些 API 的页面会假失败。假失败就换真浏览器复核，不要为了让 jsdom 通过去改生产代码。

#### 4. 逻辑验证（隔离环境 + 四通道打桩）  `[version-dependent]`

```bash
# 隔离 = jsdom 页面 + **四条出网通道全打桩**，零真实请求、零不可逆副作用、可反复跑
cat > stub.js <<'EOF'
module.exports = function install(w, $, fixtureFor) {
  const calls = w.__calls = []
  const rec = (ch, url, method, raw) => {
    let body = raw
    if (typeof raw === 'string') { try { body = JSON.parse(raw) } catch (e) {} }
    calls.push({ ch, url, method, body }); return body
  }
  const norm = u => String(u).replace(/[?&]_=\d+/, '')      // 抹掉 jQuery cache:false 的时间戳

  // ① XHR（$.ajax 默认走这条；实测：jQuery 载入之后再换也接得住）
  w.XMLHttpRequest = class {
    constructor(){ this.readyState=0; this.status=0; this.responseType=''; this.upload={addEventListener(){}} }
    open(m,u){ this._m=m; this._u=u; this.readyState=1 }
    setRequestHeader(){} overrideMimeType(){} abort(){ this.onabort && this.onabort({type:'abort'}) }
    getResponseHeader(n){ return String(n).toLowerCase()==='content-type' ? 'application/json' : null }
    getAllResponseHeaders(){ return 'content-type: application/json\r\n' }
    send(raw){ const b = rec('xhr', this._u, this._m, raw)
      const f = fixtureFor(norm(this._u), b) || { status: 200, body: {} }
      setTimeout(()=>{ if (f.networkError) { this.onerror && this.onerror({type:'error'}); return }
        this.readyState=4; this.status=f.status||200; this.statusText=this.status<400?'OK':'Error'
        this.responseURL=this._u; this.responseText=JSON.stringify(f.body)
        this.response=this.responseType==='json'?f.body:this.responseText
        this.onreadystatechange && this.onreadystatechange()
        this.onload && this.onload({type:'load'}); this.onloadend && this.onloadend({type:'loadend'}) },5) }
    addEventListener(t,fn){ this['on'+t]=fn } removeEventListener(){} dispatchEvent(){ return true }
  }

  // ② 原生 fetch（新写的代码常混用）
  w.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    const b = rec('fetch', url, (init&&init.method)||'GET', init&&init.body)
    const f = fixtureFor(norm(url), b) || { status: 200, body: {} }
    if (f.networkError) return Promise.reject(new TypeError('Failed to fetch'))
    return Promise.resolve(new w.Response(JSON.stringify(f.body),
      { status: f.status||200, headers: { 'content-type': 'application/json' } }))
  }

  // ③ jQuery 的 script / jsonp 传输层 —— XHR 桩接不住的那条（实测会真打第三方）
  $.ajaxTransport('+script', function (opt) {
    return { send (h, cb) { rec('script/jsonp', opt.url, 'GET', null)
        const f = fixtureFor(norm(opt.url), null) || { body: {} }
        if (opt.dataType === 'jsonp' && opt.jsonpCallback) w[opt.jsonpCallback](f.body)
        cb(f.status || 200, 'success') }, abort () {} }
  })

  // ④ 整页跳转：表单默认提交 / form.submit() —— 会清掉全部前端状态和 __calls
  w.HTMLFormElement.prototype.submit = function () { rec('form.submit()', this.action, 'POST', null) }
  $(w.document).on('submit', 'form', function (e) { rec('form-default', this.action, 'POST', null); e.preventDefault() })

  // ⑤ 顺手堵住的旁路
  if (w.navigator) w.navigator.sendBeacon = (u, d) => (rec('beacon', u, 'POST', d), true)
  return calls
}
EOF

# ── 打桩自检：原文要求的第一步，不过这步后面全部断言无效 ──
#   触发一个已知会发请求的操作，然后：
#     w.__calls.length > 0  → 桩生效
#     w.__calls.length === 0 → 没接住（走了 <img> 打点 / WebSocket / SW / 内联 onclick 直接 location=）
#                              停下来查，别相信「没有请求 = 已拦住」
#   再检查通道分布：console.log([...new Set(w.__calls.map(c=>c.ch))])
#   —— 只出现 'xhr' 而项目里有 jsonp/表单提交，说明那些路径这轮压根没被走到

# ── 断言（每条都要能证伪自己）──
#   点危险操作 → 确认框出现，且 __calls 里**没有**那个 url
#   fixtureFor 返回 { status: 500 } / { networkError: true } → 失败态 UI 可恢复
#   同一操作连点两次 → __calls 里该 url 只出现一次（本栈重复绑定的直接检出口）
#   重渲染列表两次 → $('#list tr').length 不翻倍
```

**说明**：对应原文「隔离环境跑断言、零不可逆副作用」。本栈没有数据库，隔离环境=打桩后的 jsdom；「不可逆副作用」全部在**网络出口**，所以隔离等价于「出口全堵住 + 自检确认堵住了」。
实测结论（jQuery 3.7.1 与 4.0.0 均验证）：
① 在 jQuery **载入之后**替换 `window.XMLHttpRequest`，`$.ajax` 依然被接住（jQuery 每次 send 时才读 `window.XMLHttpRequest`）——所以打桩代码可以放在页面所有脚本之后，不必抢在 jQuery 之前。
② `dataType:'jsonp'` 与 `dataType:'script'` **完全不出现在 XHR 桩记录里**，实测它们带着 `?callback=jQuery40007...` 真的发往 `https://third.party/j`。这是原文「只打桩一条通道 → 静默打到生产」在本栈的新形态，且比 XHR/fetch 二选一更隐蔽。第 ③ 段的 `$.ajaxTransport('+script', ...)` 实测两条都接住了。
③ `$.ajax({cache:false})` 会给 URL 追加 `?_=1788505794582`（实测），所以 `fixtureFor` **绝不能做 url 精确等值匹配**——否则永远命中不到、一律返回默认 200 空体，断言全部空洞通过。上面用 `norm()` 抹掉。
④ `form.submit()` 与表单默认提交实测都被接住。不堵这条，一次断言里的整页跳转会把 `window.__calls` 清零，而你会读成「没有请求」。
用 `$.ajaxTransport('+script')` 抢占优先级这一点只在 jQuery 4.0.0 实测过，3.x 未逐版本验证——接手时先用自检确认 `script/jsonp` 通道真的出现在 `__calls` 里。

#### 5. 部署后是否需要重启 / 会不会中断在途工作  `[confident]`

```bash
# 结论：静态站没有常驻进程，**不需要重启**。文件落盘后下一个 HTTP 请求就是新内容。
# 原文那一整套「restart <具体服务名> + 等健康检查」在本栈**不适用**（按原文要求：注明，而不是默默跳过）。

# 只有改了 web server 主配置才需要 reload；graceful 会让在途请求跑完再换 worker：
sudo apachectl -t && sudo apachectl graceful       # Apache
sudo nginx -t && sudo nginx -s reload              # nginx

# .htaccess 改动无需 reload（AllowOverride 打开时每请求重读）。先确认它真的生效：
grep -rn 'AllowOverride' /etc/apache2/ /etc/httpd/ 2>/dev/null | head

# ── 本栈真正的「在途工作」：**已经打开的浏览器标签页**。服务端任何命令都救不了它 ──
# 它手里是旧 index.html，但之后 $.getScript / $.ajax 拉的 HTML partial 会拿到**新**文件
# → 半新半旧的运行时；旧 JS 还在调可能已改契约的接口。
# 粗略估活跃会话数（近 2000 条访问里拿过入口页的独立 IP）：
sudo tail -n 2000 /var/log/apache2/access.log | awk '$7 ~ /^\/(index\.html)?(\?|$)/ {print $1}' | sort -u | wc -l

# 缓解（选一个，别都不做）：
#  a) 产物按 release 带版本路径 + 保留最近 N 个 release → 旧标签页始终能取到它那一版的文件
#  b) 页面里轮询版本戳，变了就提示用户刷新：
#     setInterval(function(){ $.ajax({url:'/version.txt', cache:false}).done(function(v){
#       if (window.APP_BUILD && v.trim() !== window.APP_BUILD) showReloadBanner() }) }, 60000)
```

**说明**：原文这条的默认答案是「重启服务并等健康检查」，本栈要整条换掉：文件是每请求从磁盘读的，没有进程持有旧代码。
代价是原文那个「在途工作」的概念整体搬家了：从「服务端长时任务/未完事务」变成「客户端已加载的旧页面」。这是本栈**唯一**的在途风险，而且它在部署完成后仍会存在几十分钟到几小时——服务端看起来一切正常。
还有一个非原子性问题：`cp -a` / `rsync` 期间用户可能拿到**新 index.html + 还没写完的 js**（404 或截断），或**旧 index.html + 新 js**。这不是理论——大目录复制有秒级窗口。修法就是下一条的软链原子换链；原地覆盖没有干净解，只能选低峰期并接受窗口。
Apache 的 `.htaccess` 每请求重读、`graceful` 让在途请求跑完，都是官方文档行为；`AllowOverride` 关掉时 .htaccess 被完全忽略（改了没反应最常见的原因），所以配了那条 grep。

#### 6. 回滚（首选：release 目录 + 原子换软链）  `[confident]`

```bash
WEB=/var/www/app; REL=$WEB/releases; STAMP=$(date +%Y%m%d-%H%M%S)
# DocumentRoot 必须指向 $WEB/current（一次性配置，之后每次部署都不碰 web server）

# 发布：整目录新建，再把软链一次换掉（对用户是瞬间切换，无半更新窗口）
mkdir -p "$REL/$STAMP"
rsync -a --exclude='.git' --exclude='node_modules' --exclude='eslint.config.js' \
      --exclude='package*.json' --exclude='.htmlvalidate.json' ./ "$REL/$STAMP/"
ln -sfn "releases/$STAMP" "$WEB/.current.tmp"
mv -Tf "$WEB/.current.tmp" "$WEB/current"     # Linux/GNU coreutils
# macOS/BSD 上换成： mv -h "$WEB/.current.tmp" "$WEB/current"
readlink "$WEB/current" | tee ~/deploy.prev    # 回滚坐标，对应原文第 2 步「记录被替换的版本」

# 回滚：换回上一个 release（瞬间、无需重启、无需重新上传）
PREV=$(ls -1t "$REL" | sed -n 2p)
ln -sfn "releases/$PREV" "$WEB/.current.tmp" && mv -Tf "$WEB/.current.tmp" "$WEB/current"
readlink "$WEB/current"

# 只留最近 5 个（别清光：旧标签页还在按老路径取文件）
ls -1t "$REL" | tail -n +6 | while read -r d; do rm -rf "$REL/$d"; done

# 换链后必须立刻验一次（软链常被 Apache 配置挡掉，见 pitfalls）
curl -s -o /dev/null -w 'index: %{http_code}\n' https://example.com/
```

**说明**：原文「tar 备份 + 记录被替换的 commit」在本栈可以升级：既然没有构建产物、整站就是一堆静态文件，直接**整目录版本化**最省事，且顺手解决三件事——原子切换（无半更新窗口）、瞬间回滚、旧标签页的文件还在磁盘上（对应上一条的在途缓解 a）。
原文「只删产物不删配置」在这里**自然消失**了：配置（.htaccess 等）留在 `$WEB` 根或写进每个 release，部署从不做删除动作，所以没有误删的门。这是选软链方案的最大收益。
实测：macOS/BSD 上 `ln -sfn 新目标 .tmp && mv -h .tmp current` 能原子替换已存在的软链（验证换链前后 readlink 与内容都变了）；`mv -Tf` 在 BSD 上直接报 `illegal option -- T`。服务器多为 Linux 用 `-Tf`，本机试脚本记得换 `-h`。
不能软链的环境（cPanel public_html 等）走下一条。

#### 6. 回滚（退路：原地部署 —— 「只删产物不删配置」的等价物）  `[confident]`

```bash
WEB=~/public_html
# 本栈**没有构建产物目录**可以整删（原文的 rm -rf $WEB/js $WEB/css 在这里就是删源码）。
# 边界只能是显式的「保留白名单」：
cat > /tmp/keep.txt <<'EOF'
.htaccess
.user.ini
.well-known/
uploads/
cgi-bin/
EOF

TS=$(date +%s)
tar czf ~/web.before.$TS.tgz -C "$WEB" .          # 回滚点

# ⚠️ 必须先 dry-run 看清要删什么，再真跑（-i 逐条列出动作）
rsync -a --delete -i --dry-run --exclude-from=/tmp/keep.txt ./ "$WEB/"
rsync -a --delete -i          --exclude-from=/tmp/keep.txt ./ "$WEB/"

# 部署后立刻断言白名单还在（这条正是原文说的「没有这类文件就删掉这行」的反面：本栈**通常真有**）
while read -r f; do [ -e "$WEB/$f" ] || echo "❌ 配置被删: $f"; done < /tmp/keep.txt

# 回滚（比 tar x 忠实：tar 解包只覆盖不删除，坏版本新加的文件会残留下来继续被引用）
mkdir -p /tmp/rb && tar xzf ~/web.before.$TS.tgz -C /tmp/rb
rsync -a --delete --exclude-from=/tmp/keep.txt /tmp/rb/ "$WEB/"
while read -r f; do [ -e "$WEB/$f" ] || echo "❌ 回滚后配置缺失: $f"; done < /tmp/keep.txt
```

**说明**：实测对照（同一份目录，跑两次 dry-run）：
- 带 `--exclude-from`：只 `*deleting js/legacy.js`（该删的旧脚本）。
- 不带：`*deleting uploads/photo.jpg`、`*deleting uploads/`、`*deleting .user.ini`、`*deleting .htaccess` —— 一条命令同时干掉重写规则、PHP 配置和全部用户上传。
所以本栈的「只删产物不删配置」= **白名单 + 强制 dry-run**，没有第三条路。原文那条 `test -f "$WEB/<配置文件名>" || rollback` 在这里不但适用，而且是**必须留**的（原文提醒「没有这类文件就删掉这行」——本栈几乎一定有 .htaccess）。
另一个原文没提的不对称：`tar xzf` 只覆盖、从不删除。用它回滚会留下坏版本新增的文件；如果坏版本加了个 `js/app.new.js` 而回滚后的 HTML 不引用它，无害；但若它是被 `$.getScript` 按约定名动态加载的，就会出现「回滚了却还在跑新代码」。所以回滚也用 rsync --delete 从解包目录同步。

#### 7. 「只有新版本才有的可观测差异」断言  `[confident]`

```bash
BASE=https://example.com; SHA=$(git rev-parse --short HEAD); PREV=$(cat ~/deploy.prev.sha 2>/dev/null)

# ── 部署前：把版本戳做进产物（无构建 → 一行生成 + 一次 sed 改路径）──
printf 'window.APP_BUILD="%s";\n' "$SHA" > js/build.js      # index.html 里第一个 <script>
printf '%s\n' "$SHA" > version.txt                            # 给前端轮询用
# 产物走带版本的**目录**（无构建时最省力的缓存失效手段，只需改路径前缀）：
mkdir -p "s/r-$SHA" && cp -a js css "s/r-$SHA/"
sed -i.bak -E "s#(src|href)=\"/s/r-[a-z0-9]+/#\\1=\"/s/r-$SHA/#g" *.html
grep -c "r-$SHA" index.html    # 断言 sed 真的命中了（0 = 没改到，别继续）

# ── 部署后：四段断言，缺任何一段都会「空洞通过」──
set -e
# ① HTML 本身是新的（必须绕过缓存取，否则你验的是自己的本地缓存）
HTML=$(curl -fsS -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' "$BASE/index.html?cb=$RANDOM")
echo "$HTML" | grep -q "r-$SHA" || { echo "❌ HTML 还是旧版（HTML 被缓存 / 没传上去）"; exit 1; }
# ② HTML 指向的每个本地 js/css 都真取得到（无构建，路径写错就是白屏）
fail=0
for p in $(echo "$HTML" | grep -oE '(src|href)="/[^"]+\.(js|css)"' | sed -E 's/.*="([^"]+)".*/\1/'); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$p")
  printf '  %-44s %s\n' "$p" "$code"; [ "$code" = 200 ] || fail=1
done
[ "$fail" = 0 ] || { echo "❌ 有资源取不到"; exit 1; }
# ③ 新字节真的在被服务（这才是原文那条「只有新版本才有的差异」）
curl -fsS "$BASE/js/build.js?cb=$RANDOM" | grep -q "$SHA" || { echo "❌ build.js 不是新的"; exit 1; }
# ④ 缓存层没有把旧字节钉住
curl -sI "$BASE/index.html" | grep -iE 'cache-control|^age:|x-cache|cf-cache-status|expires'
#   期望：index.html = no-cache/must-revalidate 且 Age: 0；只有 /s/r-<SHA>/ 下的文件才配 immutable
printf '%s\n' "$SHA" > ~/deploy.prev.sha

# ── 配套的 Apache 头（无构建栈的缓存正确性全靠这两块）──
# <FilesMatch "\.(html|txt)$">
#   Header set Cache-Control "no-cache, must-revalidate"
#   Header unset Expires
#   ExpiresActive Off
# </FilesMatch>
# <FilesMatch "^/s/r-[a-z0-9]+/.*\.(js|css)$">
#   Header set Cache-Control "public, max-age=31536000, immutable"
# </FilesMatch>
```

**说明**：实测这条断言链（本地起 server 验的）：HTML 里提出 `/js/app.c5a79a34.js`、命中期望 SHA、该路径 200、JS 内容里 grep 到 `APP_BUILD="c5a79a34"`；故意插一个 `/js/gone.js` 后第 ② 段返回 404 且 `fail=1`——即这层能证伪自己。
三种缓存失效手段的取舍：`?v=hash` 查询串最省事，但部分 CDN/代理配置会忽略查询串做缓存、且**必须** HTML 不被缓存才有意义；重命名文件（app.<hash>.js）无构建时要写脚本改名 + 改引用，容易漏；**带版本的目录前缀**（`/s/r-<sha>/`）只需一次 sed、整目录不可变、还天然给旧标签页留了旧文件，无构建栈里最划算。
唯一不可协商的规则：**HTML 绝不能被缓存，HTML 指向的一切都必须是带版本的不可变路径**。反过来（HTML 长缓存 + js 加 ?v=）等于什么都没做——用户永远拿不到新的查询串。
诚实边界：curl 只证明「源站/边缘现在吐新字节」。它**不能**证明某个用户拿到了新版——已打开的标签页仍在跑旧代码（见第 5 条）。要断言到用户侧，只能靠页面里的 `window.APP_BUILD` + version.txt 轮询提示刷新。④ 段的 `Age`/`X-Cache`/`cf-cache-status` 取决于有没有 CDN 及其配置，本地无 CDN 时为空，别把「没有这些头」当成「缓存没问题」。

> ⚠️ **修正（事实核查 1.3）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：`<FilesMatch>` 的正则只对路径的最后一段（文件名）求值，不含目录部分，含 `/` 的模式永远匹配不上。于是「带版本目录长缓存 immutable」这条规则实际从未生效，而同一段里 `<FilesMatch "\.(html|txt)$">` 恰好只用文件名所以有效 —— 一半生效一半静默失效，最难发现。整套「HTML 不缓存 + 版本目录不可变」的收益直接归零。
>
> **应改为**：改用按路径匹配的容器：`<LocationMatch "^/s/r-[a-f0-9]+/.*\.(js|css)$">` 或 `<Directory /var/www/app/s>` 内再用 `<FilesMatch "\.(js|css)$">`。另外 `[a-z0-9]` 不匹配大写 sha，git rev-parse 输出虽是小写但建议写 `[A-Za-z0-9]`。部署后必须 `curl -sI` 逐条确认这两类响应头真的不同，否则等于没配。


> ⚠️ **修正（事实核查 1.8）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：过度断言，且与该栈自己的 pitfall 第 2 条自相矛盾。客户端请求头 `Cache-Control: no-cache` 并不保证穿透 CDN/反代（Cloudflare 等默认忽略客户端的 no-cache/Pragma），而 `?cb=$RANDOM` 更是换了缓存键 —— 你验的是一个用户永远不会请求的对象。两条加起来的结论是「源站有新字节」，却被写成「HTML 是新的（否则 HTML 被缓存/没传上去）」，正是最典型的空洞通过。
>
> **应改为**：断言分两次：(1) 不带任何 cachebuster、不带 no-cache 头地取真实 URL（`curl -sSD- -o /dev/null $BASE/index.html`），看 `Age`/`X-Cache`/`cf-cache-status` 判断是否命中边缘旧对象；(2) 只在需要排除源站问题时才用 `?cb=` 直连源站 IP（`--resolve`）。并写明：有 CDN 时唯一可靠路径是部署后主动 purge HTML，再按 (1) 复验；缺 `Age`/`X-Cache` 头不等于没有缓存层。


### 本栈审查维度重点清单（替换 playbook 里 DIMS 的 focus）

- **事件重复绑定**：`$(sel).on('click', ...)` 写在 AJAX 成功回调 / 渲染函数 / 页面切换里 → 每渲染一次多一个处理器，一次点击发 N 个请求（有不可逆副作用时 = N 次副作用，无任何报错）。检出：`$._data(el,'events').click.length`（实测 jQuery 3.7.1 与 4.0.0 都可用，非公开 API），或改用带命名空间的 `.off('click.ns').on('click.ns', ...)` / 委托到稳定祖先。这是本栈替代「组件生命周期」的头号 bug 维度。

- **`.html()` 重渲染后直接绑定静默失效**：实测 `$('#box').html(...)` 后，之前 `$('#b2').on('click')` 的直接绑定触发 0 次，而 `$(document).on('click','#b2')` 的委托绑定正常触发 1 次。症状是「按钮点了没反应、console 干净」。审查时对每个 `.html()/.empty()/.replaceWith()` 问一句：它清掉的子树上有没有直接绑定？

- **脚本加载顺序与全局命名冲突**：`<script>` 顺序即依赖顺序，且所有非 module 脚本共享一个全局作用域。看四件事——插件在 jQuery 之前、某个标签被加了 `async`（顺序失效）、`defer` 与内联脚本混用（执行时机翻转）、两个文件顶层声明同名（后者悄悄覆盖前者，`var` 连报错都没有）。

- **DOM 当数据真源导致的不同步**：实测 `$el.data('id')` 会缓存首读值——`attr('data-id','99')` 之后 `.data('id')` 仍返回 `7`（而 `.attr('data-id')` 是 `99`）。凡是「写 attr、读 data」或反之的地方都是 bug。同类：从 `.text()` 反解数字/状态、把选中项存在 class 里再靠 `hasClass` 判断。

- **并发 AJAX 无序返回覆盖**：本栈几乎没人存 jqXHR 去 abort。快速切换筛选/分页时先发的请求后返回，把界面盖回旧数据。审查点——每个会被连续触发的请求有没有 ① 保存 jqXHR 并在下次发起前 `.abort()`，或 ② 递增的 seq token 在 done 里比对后再渲染。对应原文的「竞态」维度。

- **定时器 / 轮询指向已被清空的容器**：`setInterval` 里 `$('#list').html(...)`，而 `#list` 已被别处 `.html('')` 掉或整个替换 → jQuery 对空集合的操作**静默无操作**，既不报错也不停轮询。这是原文「组件卸载后仍在写已销毁组件的状态」在本栈的等价物，而且更难发现（无警告）。查所有 `setInterval/setTimeout` 有没有对应的 `clearInterval`，以及切页/切 tab 时是否真的清了。

- **`.html(服务端数据)` 的 XSS**：本栈没有框架自动转义，每一处 `.html()`、`.append('<div>'+x+'</div>')`、`$('<a>').attr('href', x)` 都是注入点。按原文 §8「安全是准入维度」——只要页面渲染他人可控的内容（用户昵称、备注、文件名、URL 参数），这一轮必须过一遍：能用 `.text()` 就别用 `.html()`；拼 HTML 的地方看有没有转义函数且**每个插值都过了**。

- **默认动作未阻止导致整页跳转**：`<a href="#">`、`<button>`（默认 type=submit）、`<form>` 提交，漏掉 `e.preventDefault()` 就是整页刷新——前端所有内存状态归零、用户填的表单没了、URL 后面多个 `#`。实测 `form.submit()` 和表单默认提交都会走出去。同时检查内联 `onclick="..."`（ESLint 看不到那里，见 mapping 2 的说明）。

### 本栈特有的坑

- **把「每个 .js 都 node --check 通过」当成门禁通过** `[confident]`
  - 为什么：实测 `$(function(){ conosle.log(a) })` 判 PASS——`node --check` 只做语法解析，**零名字检查**；而且它逐文件独立解析，看不到浏览器里所有脚本共享一个全局作用域这件事，两个文件各自 `var config = {...}` 都 PASS，线上后者静默覆盖前者。node ≥22.7 还会自动按 ESM 重解析，`import/export` 和顶层 await 也 PASS（旧 node 会 FAIL），所以它连「这文件能不能当普通 <script> 加载」都答不了。无构建栈里这层是唯一免费门禁，也正因为免费而最容易被当成全部。
  - 怎么办：三层叠起来才算门禁：① 逐文件 `node --check`（打错字）② 按 `<script src>` 真实顺序拼成一个 program（文件间插 `;\n`）再 `node --check`——实测抓到跨文件 `let SHARED` 重复声明 ③ ESLint `sourceType:'script'` + browser/jquery globals + `no-undef`——实测抓到 `conosle`。`var` 同名是合法 JS，三层都不报，只能靠顶层声明清单 `sort | uniq -d` 比对（命令见 mapping 2）。

- **HTML 自身被缓存，于是 `?v=hash` 永远到不了用户；或既有 mod_expires 规则把你新加的 no-cache 盖掉** `[version-dependent]`
  - 为什么：缓存失效的所有手段（查询串、改名、带版本目录）都依赖「用户先拿到新的 HTML」。HTML 一被缓存，整条链断在第一环，而你 curl 加 `-H 'Cache-Control: no-cache'` 一试完全正常——最典型的空洞通过。更阴的是 cPanel / 共享主机默认 vhost 或上一任留下的 `.htaccess` 里常有 `ExpiresByType application/javascript "access plus 1 year"`；`ExpiresActive` 生成的 `Expires` 头与你 `Header set Cache-Control` 并存时，浏览器与中间代理的取舍随实现而异，你以为改了其实没改。
  - 怎么办：规则只有一条且不可协商：**HTML 一律 no-cache，HTML 指向的一切一律带版本的不可变路径**。配置上要连 `Header unset Expires` + `ExpiresActive Off` 一起写在 `<FilesMatch "\.html$">` 里，不能只 `Header set Cache-Control`。部署后用**不带**任何 no-cache 头的 `curl -sI $BASE/index.html` 看实际头，并断言 `Age: 0`；有 CDN 的还要显式 purge 后再断言。

- **`rsync --delete` 没有保留白名单，一条命令删掉 .htaccess / .user.ini / uploads/** `[confident]`
  - 为什么：原 playbook 的 `rm -rf "$WEB/js" "$WEB/css"` 前提是「有构建产物目录可以整删」。本栈**没有产物目录**——`$WEB/js` 就是源码本身，配置文件和用户上传与它混在同一棵目录树里。实测同一份目录跑 dry-run：带 exclude 只 `*deleting js/legacy.js`；不带 exclude 则 `*deleting uploads/photo.jpg`、`*deleting uploads/`、`*deleting .user.ini`、`*deleting .htaccess` —— 重写规则、PHP 配置、全部用户上传一次没了，而且 rsync 会报「部署成功」。
  - 怎么办：`--exclude-from=keep.txt` 白名单化，且**每次都先 `--dry-run -i` 看清删除清单再真跑**。部署后 `while read -r f; do [ -e "$WEB/$f" ] || echo "❌ 配置被删: $f"; done < keep.txt`。更彻底的解法是改用 release 目录 + 原子换软链——部署过程完全不执行删除动作，这道门直接不存在。

- **`dataType:'jsonp'` / `dataType:'script'` 绕过 XHR 桩，打桩后仍真打第三方或生产** `[version-dependent]`
  - 为什么：原 playbook 提醒的是「XHR 和 fetch 要都打」。本栈还有第三条：jQuery 的 jsonp/script 传输层是**注入 `<script>` 标签**，不经过 XMLHttpRequest。实测（jQuery 4.0.0）换掉 `window.XMLHttpRequest` 后，`$.ajax({url:'https://third.party/j', dataType:'jsonp'})` 在桩记录里**一条都没有**，实际带着 `?callback=jQuery40007...` 真的发了出去。老 jQuery 项目里 jsonp 用来跨域取配置/打点非常常见。附带两个：`$.ajax({cache:false})` 会给 URL 追加 `?_=<时间戳>`（实测），fixtureFor 做 url 精确等值匹配就永远命中不到、一律返回默认 200 空体，后面所有断言空洞通过；`$.ajax({global:false})` 的请求**不触发** `ajaxSend`（实测），只靠 `$(document).on('ajaxSend')` 当记录器会漏掉它们。
  - 怎么办：打桩要四条通道：XHR、fetch、`$.ajaxTransport('+script', ...)`（实测同时接住 jsonp 与 script）、表单提交/整页跳转。`fixtureFor` 的 url 先过 `String(u).replace(/[?&]_=\d+/,'')` 归一化。打桩自检不只看 `__calls.length > 0`，还要看 `[...new Set(__calls.map(c=>c.ch))]` —— 项目里明明有 jsonp 而通道分布里只有 `'xhr'`，说明那条路径这轮压根没被走到，别当成「已拦住」。

- **换成 release + 软链后整站 403，或用 GNU 写法在 BSD 上换链失败** `[version-dependent]`
  - 为什么：Apache 要跟随软链需要 `Options +FollowSymLinks`；cPanel/共享主机的默认是 `SymLinksIfOwnerMatch`，软链与目标属主不一致（常见于 root 部署到用户目录、或 rsync 带了 `-o`）时直接 403 —— 而这个 403 出现在换链**之后**，看起来像「新版本代码坏了」，实际是权限模型。另外 `mv -Tf`（原子替换已存在的软链）是 GNU coreutils 专有，实测在 macOS/BSD 上直接报 `illegal option -- T`；用 `mv -f` 不带 `-T` 会把新链**移进** current 目录里，得到 `current/current` 这种诡异结构，站点仍指向旧 release 却不报错。
  - 怎么办：第一次改成软链方案时，换链后立刻 `curl -s -o /dev/null -w '%{http_code}' $BASE/`，403 就去查 `Options` 与 `ls -ln` 的属主，而不是回滚代码。命令按平台选：Linux `ln -sfn 目标 .tmp && mv -Tf .tmp current`；macOS/BSD `ln -sfn 目标 .tmp && mv -h .tmp current`（实测可用）。换完必须 `readlink current` 确认指向对了，别只看站点还活着。

- **用系统自带 tidy 做 HTML 门禁 / 让 lint 去扫 vendor 与 *.min.js** `[confident]`
  - 为什么：macOS 自带的是 2006 年 Apple build 的 HTML Tidy，实测对 HTML5 报 `<main> is not recognized!`、`<meta> proprietary attribute "charset"` —— 全是假错，而真问题（重复 id、未闭合 div）混在里面。同理，ESLint 扫压缩过的 jquery.min.js 会刷出成百条，人看两次之后的反应一定是把整条规则关掉。这正是原文那条「你自己新加的门禁，误报的代价可能比不加更大」在本栈的具体形态：本栈没有构建，门禁全靠人主动跑，一噪就被弃用，然后回到零门禁。
  - 怎么办：HTML 用 `npx html-validate`（实测精准命中 `Duplicate ID`、`Unclosed element`），并把 `doctype-style` / `no-implicit-button-type` / `no-implicit-input-type` / `require-sri` 这几条纯风格关掉。ESLint 配置第一项就写 `ignores: ['**/vendor/**','**/*.min.js','node_modules/**']`。全站太脏时先只守本次改动的文件（`npx eslint $(git diff --name-only HEAD | grep '\.js$')`），把「全站干净」当渐进目标，别当准入条件。


## Vue 2 前端（Options API，vue-cli 4 / webpack 4，Vuex 3 + vue-router 3 + mixins + this.$bus 事件总线，构建产物静态部署到 Apache/nginx）

### 七类动作的命令映射

#### 1. 语法检查（只验打错字）  `[confident]`

```bash
cd frontend
# a) .js/.jsx 纯语法（Babel 只解析不产出，不跑规则）
npx babel src --out-dir /dev/null --extensions '.js,.jsx' 2>&1 | tail -20

# b) .vue 的 <template> 语法 —— Vue2 专属，必须用 vue-template-compiler
find src -name '*.vue' -print0 | xargs -0 node -e '
const c=require("vue-template-compiler"),fs=require("fs");let bad=0;
for(const f of process.argv.slice(1)){
  const sfc=c.parseComponent(fs.readFileSync(f,"utf8"));
  if(sfc.template&&sfc.template.content&&sfc.template.lang!=="pug"){
    const r=c.compile(sfc.template.content);
    if(r.errors.length){bad=1;console.log("x",f,"|",r.errors.join("; "));}
  }
}
process.exit(bad);'
echo "exit=$?  (0=模板语法全过)"
```

**说明**：vue-template-compiler 的 parseComponent/compile 是 Vue2 官方 API，vue-loader@15 项目里它已经是既有依赖（且必须与 vue 版本严格同号）。这一层比 Vue3 更值得单独跑：Vue3 用 @vue/compiler-sfc，模板错误在 vite/webpack 里立刻红；Vue2 的模板编译错误常常只在运行到那个组件时才白屏。npx babel 需要 @babel/cli（vue-cli 项目默认没装，可 npm i -D @babel/cli 或用下一条的 eslint 兼做语法层）。

> ⚠️ **修正（事实核查 1.15）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：注释与命令都不成立。Babel 是转译器，`--out-dir` 会真的写盘产出；而 `/dev/null` 是字符设备不是目录，babel-cli 尝试在其下建目录/写文件会 ENOTDIR 失败并非零退出 —— 于是这条「纯语法层」在任何项目上都报错，且报的不是语法问题，最容易被误判成源码有错。
>
> **应改为**：只要语法层就写 `npx babel src --extensions '.js,.jsx' --out-file /dev/null`（写字符设备是合法的，babel 会把结果拼一起丢掉），或不装 @babel/cli 而用 `node -e` 调 `@babel/parser` 逐文件 `parse()`。更实际的做法就是该条自己提到的兜底：直接用 `eslint --ext .js,.jsx,.vue`（它内部用同一个 parser）兼掉语法层，省掉 @babel/cli 这个 vue-cli 项目本来没有的依赖。


#### 2. 静态检查（未定义名/未用变量/类型）—— 抓自己新引入 bug 的主力层  `[version-dependent]`

```bash
cd frontend
# 关键：Vue2 项目必须用 eslint-plugin-vue 的「非 vue3」预设
# .eslintrc.js  extends: ['plugin:vue/recommended', 'eslint:recommended']   ← Vue2
#                （不是 'plugin:vue/vue3-essential'）
# env: { browser: true, node: true, es2021: true }   ← 少了 browser，no-undef 会误报 window/document
npx vue-cli-service lint --no-fix --max-warnings 0
# 或绕开 vue-cli 直接跑，CI 里更可控：
npx eslint --ext .js,.jsx,.vue src/ --max-warnings 0

# 补上 Vue2 模板里的「未定义名」检查（默认所有预设都不开）
# .eslintrc.js rules:
#   'vue/no-undef-properties': 'error'        // {{ foo }} / this.foo 未在 data/props/computed/methods 声明
#   'vue/no-unused-properties': 'warn'
#   'vue/no-unused-components': 'error'
#   'vue/require-valid-default-prop': 'error' // 对象/数组 prop 必须工厂函数
#   'vue/no-side-effects-in-computed-properties': 'error'
#   'vue/no-mutating-props': 'error'
#   'vue/require-valid-v-slot': 'error'
#   'no-unused-vars': ['error', { args: 'after-used' }]

# TS 项目（Vue 2.7 + Volar）：
npx vue-tsc --noEmit   # tsconfig.json 里需 "vueCompilerOptions": { "target": 2.7 }
```

**说明**：这是 Vue2 里最该加码的一层，原因是 Vue2 的 template 天生没有名字/类型检查：<template> 里写错的属性名不会有任何编译期报错，只会渲染成空 —— 表现为「界面少了一块」而不是报错。vue/no-undef-properties 是 eslint-plugin-vue ≥9 才有的规则、任何预设都不启用，且对 mixins 注入的属性、$attrs、Vuex mapState 展开会误报（用 // eslint-disable-next-line 或 settings 白名单收敛）。预设命名分叉：plugin-vue v7 起 essential/strongly-recommended/recommended = Vue2，vue3-* = Vue3；v6 及更早只有 Vue2 版预设。

#### 3. 静态检查（Vue2 特有：只绑不解 = 内存泄漏 + 重复触发）  `[confident]`

```bash
cd frontend
# 事件总线：$on 的文件集合 减去 $off 的文件集合 = 嫌疑清单
rg -l --glob '*.{vue,js}' '\$(bus|root)\.\$on\(|EventBus\.\$on\(' src | sort > /tmp/on.txt
rg -l --glob '*.{vue,js}' '\$(bus|root)\.\$off\(|EventBus\.\$off\(' src | sort > /tmp/off.txt
comm -23 /tmp/on.txt /tmp/off.txt      # 只绑不解 → 逐个确认

# 定时器 / 原生监听 / websocket 同法
rg -l 'setInterval\(|setTimeout\(' -g '*.{vue,js}' src|sort >/tmp/a; rg -l 'clearInterval\(|clearTimeout\(' -g '*.{vue,js}' src|sort >/tmp/b; comm -23 /tmp/a /tmp/b
rg -c 'addEventListener\(' -g '*.{vue,js}' src; rg -c 'removeEventListener\(' -g '*.{vue,js}' src

# 运行时坐实（浏览器 console）：反复进出同一路由 3 次，数字不该增长
const bus = document.querySelector('#app').__vue__.$bus   // 你的 bus 挂载位置
Object.entries(bus._events).map(([k,v]) => [k, v && v.length])
```

**说明**：回答「事件总线不解绑会怎样」：bus 是个长生命周期的 Vue 实例，$on 把 handler 存进 bus._events[event] 数组；handler 是绑定在组件实例上的方法，闭包持有 vm → vm 持有 $el 整棵子树 → 组件销毁后整个实例和 DOM 都 GC 不掉（真泄漏）。更常被当成「玄学 bug」的是第二个后果：路由进出 N 次就绑了 N 份，一次 $emit 触发 N 次 → N 份重复请求 / N 个 toast / 重复 router.push。这确实是 Vue2 特有高发源：Vue3 删掉了实例上的 $on/$off/$emit，逼你换 mitt 并显式 off，同类问题少得多。修法固定写在 beforeDestroy：this.$bus.$off('evt', this.handler)。

#### 4. 静态检查/审查（生命周期钩子名映射 + 「卸载不停轮询」的落地修法）  `[confident]`

```bash
# Vue3 → Vue2（Options API）钩子对照
#   onBeforeMount   → beforeCreate/beforeMount
#   onMounted       → mounted
#   onBeforeUpdate  → beforeUpdate      onUpdated → updated
#   onBeforeUnmount → beforeDestroy     onUnmounted → destroyed
#   onActivated/onDeactivated → activated / deactivated
#   onErrorCaptured → errorCaptured
# 清定时器/轮询写在 beforeDestroy（此时实例还完整可用），keep-alive 下还要写 deactivated

export default {
  data () { return { timer: null } },
  mounted () {
    this.timer = setInterval(this.poll, 3000)
    window.addEventListener('resize', this.onResize)
    this.$bus.$on('job:done', this.onJobDone)
  },
  activated ()   { if (!this.timer) this.timer = setInterval(this.poll, 3000) },
  deactivated () { this.stopPoll() },     // keep-alive：destroy 钩子永不触发
  beforeDestroy () {
    this.stopPoll()
    window.removeEventListener('resize', this.onResize)
    this.$bus.$off('job:done', this.onJobDone)   // 必须同一函数引用
    this.cancelSource && this.cancelSource.cancel('component destroyed')
  },
  methods: {
    stopPoll () { clearInterval(this.timer); this.timer = null },
    async poll () {
      const r = await api.status()
      if (this._isDestroyed) return          // 在途请求晚回来，别再 setData
      this.status = r.data
    }
  }
}

# 一次性副作用的 Vue2 惯用简写（Vue3 已移除 hook: 事件）：
# const t = setInterval(fn, 1000); this.$once('hook:beforeDestroy', () => clearInterval(t))

# 扫描命令：mounted 里起了 interval 但同文件没有 beforeDestroy 的组件
rg -l --glob '*.vue' 'setInterval' frontend/src | xargs rg -L 'beforeDestroy|hook:beforeDestroy'
```

**说明**：Vue2 里没有 onUnmounted 这个名字（除 Vue 2.7 + Composition API，那里 onUnmounted 映射到 destroyed、onBeforeUnmount 映射到 beforeDestroy）。beforeDestroy 与 destroyed 都能清定时器，选 beforeDestroy 的理由是 $refs/$el/$store 都还在，可以在同一处顺带取消在途请求。this._isDestroyed 是 Vue 2.x 私有字段（destroyed 后为 true），2.x 全系可用但属于私有 API，洁癖做法是自己 data 里加 alive 标志。$once('hook:beforeDestroy') 是 Vue2 专属，Vue3 无。

> ⚠️ **修正（事实核查 1.4）—— 以下方为准，别照抄上面的原始命令**
>
> **错在**：ripgrep 的 `-L` 是 `--follow`（跟随符号链接），不是「列出不匹配的文件」（本机 rg --help 实测确认）。所以这条命令会把 pattern 当普通搜索、输出**已经写了 beforeDestroy** 的那些文件 —— 结论和意图完全相反：真正漏清定时器的组件一个都不会被列出来，反而列出一堆已经修好的。这条被标 confident 且是该条唯一的自动扫描手段。
>
> **应改为**：`rg -l --glob '*.vue' 'setInterval' frontend/src | xargs rg --files-without-match 'beforeDestroy|hook:beforeDestroy'`（`--files-without-match` 只有长选项）。同一条还应把 keep-alive 情形纳入：模式改成 `'beforeDestroy|hook:beforeDestroy|deactivated'`，否则按该条自己的 pitfall，keep-alive 路由下仍然修不干净。


#### 5. 加载冒烟（真加载入口一次，验循环依赖与模块级副作用）  `[version-dependent]`

```bash
cd frontend
# a) 循环依赖：webpack 层强断言（Vue2 常见 vue-cli 4 = webpack 4）
npm i -D circular-dependency-plugin@5
# vue.config.js:
#   const CircularDependencyPlugin = require('circular-dependency-plugin')
#   module.exports = { configureWebpack: { plugins: [ new CircularDependencyPlugin({
#     exclude: /node_modules/, include: /src/, failOnError: true, allowAsyncCycles: false }) ] } }
npx vue-cli-service build --mode development --no-clean

# b) 真的把入口加载一次（等价于后端的 python -c "import app"）
npm i -D @vue/cli-plugin-unit-jest@~4 vue-jest@^4 jest@^24 @vue/test-utils@^1
cat > tests/unit/smoke.spec.js <<'EOF'
jest.mock('axios')                        // 入口里模块级发的请求先掐掉
describe('entry', () => {
  it('main.js 能加载并挂载，不抛异常', () => {
    document.body.innerHTML = '<div id="app"></div>'
    expect(() => require('@/main.js')).not.toThrow()
    expect(document.querySelector('#app')).toBeTruthy()
  })
})
EOF
npx vue-cli-service test:unit tests/unit/smoke.spec.js
```

**说明**：关键差异：Vue3+vite 的入口冒烟可以靠 dev server 秒起，Vue2+webpack 没有这个便利，jest+jsdom require('@/main.js') 才是真正会执行「模块级副作用」的那条路（Vuex store 创建、Vue.use 注册、axios 拦截器、window 上挂东西、router 守卫注册）。注意「零不可逆副作用」的前提：入口若有 location.href 跳转、埋点上报、自动登录请求，必须先 jest.mock 掉，否则冒烟本身会打真接口。madge --circular --extensions js,vue 对 .vue 的解析支持我不确定（uncertain），别把它当唯一依据。

#### 6. 逻辑验证（隔离环境跑断言，零不可逆副作用）  `[version-dependent]`

```bash
cd frontend
# Vue2 必须用 @vue/test-utils@1（v2 只支持 Vue3）、vue-jest@4 或 @vue/vue2-jest
npx vue-cli-service test:unit                       # 全量
npx vue-cli-service test:unit tests/unit/shot.spec.js -t '轮询在销毁后停止'   # 单条

// tests/unit/shot.spec.js —— Vue2 写法要点
import { mount, createLocalVue } from '@vue/test-utils'   // createLocalVue 是 v1 专属，v2 已删
import Vuex from 'vuex'
jest.mock('@/api')                                        // 隔离：不打真接口、不写真库
const localVue = createLocalVue(); localVue.use(Vuex)

it('销毁后不再轮询', async () => {
  jest.useFakeTimers()
  const store = new Vuex.Store({ modules: { job: { namespaced: true, state: () => ({}) } } })
  const w = mount(ShotCard, { localVue, store, propsData: { id: 1 } })
  jest.advanceTimersByTime(9000)
  expect(api.status).toHaveBeenCalledTimes(3)
  w.destroy()                        // v1 是 destroy()，v2 才叫 unmount()
  jest.advanceTimersByTime(9000)
  expect(api.status).toHaveBeenCalledTimes(3)   // 没涨 = beforeDestroy 真的清了
})

it('新增字段能触发重渲染', async () => {
  const w = mount(Panel)
  w.vm.$set(w.vm.form, 'title', 'x')   // 注意：w.vm.form.title='x' 不会触发更新
  await w.vm.$nextTick()
  expect(w.text()).toContain('x')
})
```

**说明**：前端没有「临时库」，隔离靠三件套：jsdom + jest.mock 掉 api/axios 模块 + 每个 case afterEach(() => { localStorage.clear(); jest.clearAllMocks() })。Vue2 与 Vue3 的 API 分叉必须记牢：v1 用 propsData（v2 是 props）、destroy()（v2 unmount()）、createLocalVue + localVue.use()（v2 用 global.plugins）、setData 后要 await $nextTick。Vue2 里 fake timers + w.destroy() 的组合就是「卸载不停轮询」这条 bug 的回归测试模板。

#### 7. 逻辑验证（打桩/真渲染验证：拿到组件实例读写内部状态）  `[confident]`

```bash
// Vue3: el.__vueParentComponent.ctx / el.__vue_app__
// Vue2 等价物：el.__vue__   —— 挂在「组件根 DOM 元素」上，dev/prod 构建都有（devtools 就靠它）
const root = document.querySelector('#app').__vue__      // 根实例（= new Vue(...) 那个）
const vm   = document.querySelector('.shot-card').__vue__ // 任意子组件

// 元素不是组件根节点时 __vue__ 为 undefined，往上找：
const find = el => { let n = el; while (n && !n.__vue__) n = n.parentElement; return n && n.__vue__ }
const vm2 = find(document.querySelector('.shot-card .title'))

// 遍历树 / 定位组件
root.$children; vm.$parent; vm.$refs; vm.$root
const all = (v, out=[]) => (out.push(v), v.$children.forEach(c => all(c, out)), out)
all(root).filter(v => v.$options.name === 'ShotCard').length

// 读写内部状态（响应式，会真的重渲染）
vm.$data; vm.status; vm.polling = false
vm.$set(vm.form, 'newKey', 1)          // 新增字段必须 $set
vm.$store.state.job.list; vm.$store.commit('job/setList', [])   // Vuex
await vm.$nextTick(); vm.$forceUpdate()

// 事件总线现场取证
Object.entries(root.$bus._events).map(([k,v]) => [k, v && v.length])

// 找根实例（不知道挂在哪个节点时）
[...document.querySelectorAll('*')].find(e => e.__vue__ && e.__vue__.$root === e.__vue__)
```

**说明**：__vue__ / _events / _isDestroyed 都是 Vue 2.x 的私有字段，Vue3 一个都没有（Vue3 那两个还是 dev-only），所以「真渲染验证」这一段在 Vue2 里其实比 Vue3 更好做、且生产构建也能用。唯一限制：__vue__ 只在组件的根元素上，函数式组件（functional: true）没有实例、拿不到。写状态时记住走 $set / 整体替换，直接 vm.obj.k=1 只改了值不触发视图 —— 会让你误判「改了没生效」。

#### 8. 部署后是否需要重启 + 会不会中断在途工作  `[confident]`

```bash
# Vue2 前端是纯静态产物 —— 没有进程要重启，无需 pm2 restart，也不存在「重启杀掉在途请求」
npx vue-cli-service build          # → dist/  (vue-cli 4 布局)
#   dist/index.html                （不带 hash）
#   dist/js/app.<contenthash:8>.js
#   dist/js/chunk-vendors.<hash>.js
#   dist/js/chunk-<name>.<hash>.js  ← 路由懒加载切出来的
#   dist/css/*.css  dist/img/  dist/fonts/

# 只有改了 vhost 才需要动 web server（graceful 不打断在途请求）
sudo apachectl configtest && sudo apachectl -k graceful     # nginx: nginx -t && nginx -s reload

# 真正会「中断在途工作」的是旧 chunk 被删：已开着页面的用户点懒加载路由 → ChunkLoadError
# 兜底（Vue2 + vue-router 3）：
router.onError(err => {
  if (/Loading( CSS)? chunk \S+ failed|Loading chunk \d+ failed/i.test(err.message)) {
    window.location.reload()
  }
})
Vue.config.errorHandler = (err, vm, info) => console.error('[vue]', info, err)

# Apache 缓存策略（mod_headers）：index.html 绝不缓存，带 hash 的资源长缓存
# <FilesMatch "index\.html$">  Header set Cache-Control "no-store, must-revalidate"  </FilesMatch>
# <FilesMatch "\.(js|css|woff2?|png|jpe?g|svg)$">  Header set Cache-Control "public, max-age=31536000, immutable"  </FilesMatch>
# history 模式必须有兜底，否则深链刷新 404：
# <Directory /var/www/app>  Options -Indexes +FollowSymLinks
#   FallbackResource /index.html
# </Directory>
```

**说明**：「部署后旧 chunk 404」在 Vue2/vue-cli 4 里同样存在，而且成因跟框架无关 —— 是 webpack 代码分割 + 用户手里那份旧 index.html 的组合：旧 index 引用 chunk-abc.<oldhash>.js，你 rsync --delete 把它删了，用户一点路由就白屏报 Loading chunk failed。三件套解法：① 部署不删旧文件（见回滚那条）；② router.onError 自动 reload；③ index.html no-store。vue-cli 4 默认 filenameHashing: true、contenthash 取 8 位；若部署在子路径必须设 publicPath: '/app/'，否则 chunk 请求打到根路径 404。

#### 9. 回滚  `[confident]`

```bash
# 发布结构（保留历史版本，秒级回滚，且旧 chunk 不消失）
TS=$(date +%Y%m%d-%H%M%S)
rsync -az --delete dist/ deploy@host:/var/www/app/releases/$TS/
ssh deploy@host "ln -sfn /var/www/app/releases/$TS /var/www/app/current.new && mv -Tf /var/www/app/current.new /var/www/app/current"   # 原子换链，无重启

# 回滚到上一版
PREV=$(ssh deploy@host "ls -1t /var/www/app/releases | sed -n 2p"); echo "$PREV"
ssh deploy@host "ln -sfn /var/www/app/releases/$PREV /var/www/app/current.new && mv -Tf /var/www/app/current.new /var/www/app/current"

# 更省事、且天然解决旧 chunk 404 的替代方案：同一 docroot 叠加发布 + 定期清理
rsync -az dist/ deploy@host:/var/www/app/          # 注意：不加 --delete，新旧 chunk 共存
ssh deploy@host "find /var/www/app/js /var/www/app/css -type f -mtime +30 -delete"
# 这种模式下回滚 = 重新 rsync 上一版的 dist（index.html 覆盖回去即可，hash 资源都还在）
```

**说明**：回滚不需要重启任何进程，用户只要下一次拿到新的 index.html（因为它 no-store）就回到旧版本。两个坑：① mv -Tf 是 GNU coreutils，macOS/BSD 上没有 -T（本地演练用 ln -shf 或先 rm 再 ln，就不再原子了）；② symlink 方案切走后旧 release 目录里的 chunk 从 current 视角消失，在途用户照样 404 —— 要么把 /js /css 用 Alias/RewriteCond 兜到 releases 共享目录，要么直接用第二种叠加发布。Apache 需 Options +FollowSymLinks；切链后是否要 apachectl -k graceful 取决于 EnableMMAP/EnableSendfile 和文件缓存配置（uncertain，建议实测一次）。

#### 10. 只有新版本才有的可观测差异（证明新代码真的生效）  `[confident]`

```bash
# 构建时把版本号焊进产物（vue-cli 只内联 VUE_APP_ 前缀的环境变量）
cd frontend
SHA=$(git rev-parse --short HEAD)
VUE_APP_BUILD="$SHA-$(date +%m%d%H%M)" npx vue-cli-service build
# main.js 顶部加：
#   window.__BUILD__ = process.env.VUE_APP_BUILD
#   console.info('[build]', window.__BUILD__)

# 部署后从外部断言，不用开浏览器：
HOST=https://videotool.example.com
NEW=$(curl -s -H 'Cache-Control: no-cache' $HOST/ | grep -o 'js/app\.[0-9a-f]\{8\}\.js' | head -1); echo "index 引用: $NEW"
curl -s "$HOST/$NEW" | grep -c "$SHA" ; echo "^ 期望 >=1（新构建号出现在 app chunk 里）"
curl -sI $HOST/ | grep -i -E 'cache-control|etag|last-modified'

# 浏览器 console 三连（第 2、3 条是 Vue2 专属的强证据）：
window.__BUILD__
document.querySelector('#app').__vue__.$options.MY_NEW_FLAG        // 新版才注册的选项/插件
Object.keys(document.querySelector('#app').__vue__.$store._modulesNamespaceMap)  // 新版才有的 Vuex 模块

# 反例（不能当证据）：dist 里文件 mtime、chunk hash 变了、以及「我 rsync 成功了」
#   —— 用户手里的旧 index.html 可能被中间层缓存，页面跑的仍是旧 app.js
```

**说明**：选断言点的原则和后端一样：挑一个「旧版本里根本不存在」的可观测量。前端最稳的三个是 ①index.html 里引用的 app.<hash>.js 文件名变化 + 该 chunk 内含新构建号（curl 就能验，无需浏览器）②window.__BUILD__ ③新版才注册的 Vuex 模块名/全局组件名（用 __vue__ 现场读）。一个 Vue2/webpack4 的额外注意：contenthash 只保证「内容一样则 hash 一样」，反过来改一个文件可能连带改掉其它 chunk 的 hash（webpack 4 的 module/chunk id 分配），所以别用「某个 chunk 的 hash 没变」推断「这个文件没改」（uncertain，取决于是否配了 hashed moduleIds）。

### 本栈审查维度重点清单（替换 playbook 里 DIMS 的 focus）

- 【Vue2 响应式三大盲区】改动里凡有「给对象加字段 / 按下标改数组 / 改 length」的写法，一律标红：this.obj.newKey = v 不触发更新（data 初始化时才 walk + defineProperty，新 key 没 getter/setter）→ 改 this.$set(this.obj,'newKey',v) 或整体替换 this.obj = { ...this.obj, newKey: v }；delete this.obj.k 不触发 → this.$delete；this.list[0] = x 不触发（Vue2 只劫持 push/pop/shift/unshift/splice/sort/reverse 七个变异方法，不劫持索引 setter）→ this.$set(this.list,0,x) 或 this.list.splice(0,1,x)；this.list.length = 0 不触发 → this.list = [] 或 this.list.splice(0)。共同症状是「值其实变了、视图不动」，极易被误判成接口没返回。Vuex mutation 里同理，必须 Vue.set(state.obj,k,v)。

- 【组件销毁清理清单】每个新增/改动的组件过一遍 beforeDestroy：clearInterval/clearTimeout、$bus.$off（传同一函数引用）、window/document.removeEventListener、ws.close()、axios CancelToken.cancel()、IntersectionObserver/ResizeObserver.disconnect()、第三方图表实例 dispose()。被 <keep-alive> 包住的组件还必须有 deactivated（destroy 钩子永不触发）+ activated 里重启。

- 【事件总线成对性】this.$bus.$on / EventBus.$on 必须与 beforeDestroy 里的 $off 一一对应，且 $off 第二参必须是同一函数引用（this.handler 可以，匿名箭头函数解不掉）；禁止用无参 $off(event)（会连坐清掉其它组件的监听）。审查时用 comm 对比 $on/$off 的文件集合，运行时用 bus._events[evt].length 在反复进出路由后是否增长坐实。

- 【mixins 的隐形耦合】同名生命周期钩子 mixin 与组件「都会执行」（mixin 先），所以两个 mixin 各自起的定时器要各自清；同名 methods/computed 组件覆盖 mixin、同名 data key 组件赢 —— 全部静默无警告。改一个 mixin 前先 rg 出所有 mixins: [xxx] 的消费方；组件里出现来源不明的 this.xxx 时先怀疑 mixin 注入（也是 vue/no-undef-properties 误报的主因）。

- 【Options API 的固定写法约束】组件 data 必须是函数（对象会在多实例间共享状态）；对象/数组类型的 prop 默认值必须工厂函数 default: () => ({})；不得直接改 prop（Vue2 只给 warning，不报错）；computed 里不做副作用/不改 state；watch 深层对象要 deep: true、需要首次执行要 immediate: true，且监听引用未变的对象（原地改字段）不会触发。

- 【v-for 的 key】必须有 :key 且不能用数组 index —— Vue2 的就地复用策略会让「删中间一项」后剩余项复用错节点，表现为 input 里的值、勾选状态、局部展开态串到别的行；配合 <keep-alive>/组件内部 data 时尤其明显。key 用业务唯一 id。

- 【构建与部署配置】publicPath 与实际部署路径一致（子路径必须写 '/app/'，否则 chunk 请求打到根路径 404）；vue-router history 模式必须有服务端兜底（Apache FallbackResource /index.html），否则深链刷新 404；index.html 必须 no-store、hash 资源 immutable；部署不得 --delete 清掉旧 chunk；router.onError 里有 ChunkLoadError → reload 兜底。

- 【lint/测试栈的版本正确性】eslint 配置 extends 的是 plugin:vue/recommended 系（Vue2）而不是 vue3-*；@vue/test-utils 是 1.x；vue-template-compiler 与 vue 版本号完全一致；改动引入的新依赖要确认支持 Vue2（很多库 3.x 版本已只支持 Vue3，Vue2 要装它的 2.x 分支，如 vue-router@3、vuex@3、ant-design-vue@1.x）。

### 本栈特有的坑

- **响应式静默失效会伪装成「功能坏了」，连你写的测试都会误判** `[confident]`
  - 为什么：Vue2 用 Object.defineProperty，新增属性、数组下标赋值、改 length 三种写法「值真的改了但没有通知」。于是排查时看到 this.form.title 已经是新值、接口也返回了，界面就是不动；点一下别的东西（触发了其它 re-render）又突然对了 —— 很容易被归因成「后端偶发」「浏览器缓存」。在单测里同样成立：wrapper.vm.obj.k = 1; await $nextTick(); expect(wrapper.text()).toContain('1') 会失败，让人以为组件模板写错了。Vue3 换 Proxy 后这一整类问题不存在，所以从 Vue3 项目搬过来的 playbook 完全没有这一层。
  - 怎么办：审查层：把「新增字段 / 下标赋值 / length」列为改动红线，统一走 this.$set / this.$delete / splice / 整体替换新对象；已知会动态加字段的对象在 data 里先声明好全部 key（占位 null）。验证层：单测和 console 打桩都用 vm.$set(...) 写状态；怀疑响应式失效时先 vm.$forceUpdate() 一下 —— 如果 forceUpdate 后界面就对了，100% 是响应式写法问题而不是数据问题。

- **<keep-alive> 下 beforeDestroy/destroyed 永远不执行，轮询在后台继续跑** `[confident]`
  - 为什么：被 keep-alive 缓存的组件切走只会触发 deactivated，实例和定时器都还活着。表现是「退出详情页后网络面板里 3 秒一次的 status 请求还在刷」，来回切几个 tab 就叠成 N 条并发轮询，看起来像后端被打爆或前端疯了。原 playbook 那条「卸载不停轮询」的修法只写了卸载钩子，在 keep-alive 路由（Vue2 项目里 <keep-alive><router-view/></keep-alive> 是标配写法）下修不干净。
  - 怎么办：清理逻辑抽成 this.stopPoll()，同时挂在 beforeDestroy 和 deactivated 上，启动逻辑同时挂 mounted 和 activated（activated 里判 if (!this.timer) 防重复）。验证：进入页面 → 切走 → 观察网络面板 10 秒应无该请求 → 切回应恢复；自动化用 wrapper.destroy() 之外再补一条 wrapper.vm.$options.deactivated 存在性断言，或用 e2e 走真实路由切换。

- **$off 解不掉：匿名函数无法解绑，而无参 $off 会误伤别的组件** `[confident]`
  - 为什么：$bus.$on('evt', () => this.reload()) 之后无论怎么写 $off('evt', () => this.reload()) 都解不掉（两个箭头函数不是同一引用），于是「我明明写了 $off」但重复触发依旧。反过来图省事写 $bus.$off('evt') 会清空该事件的全部监听 —— 把同时在监听这个事件的其它组件一起弄哑，症状是「A 页面进出一次以后 B 页面的实时刷新就没了」，这种 bug 几乎不可能靠读单个文件发现。
  - 怎么办：handler 一律写成 methods 里的命名方法（Vue2 会把 methods 一次性 bind 到 vm，引用稳定），配对写 this.$bus.$on('evt', this.onEvt) / this.$bus.$off('evt', this.onEvt)。审查时 rg '\$off\([^,)]+\)' src 找出所有无第二参的 $off 逐个质询。运行时取证：Object.entries(bus._events).map(([k,v])=>[k,v&&v.length])，进出路由 3 次后数字不涨、且切走 A 页面后 B 页面关心的事件数量没减少。

- **webpack 里「导入了一个不存在的导出」只是 warning，构建照样成功、上线后运行时才 undefined** `[confident]`
  - 为什么：import { getShotList } from '@/api' 里名字打错，webpack 只打印 "export 'getShotList' was not found in '@/api'" 这一行 warning，exit code 仍是 0，CI 全绿，dist 正常产出，直到用户点到那个按钮才 TypeError: _api.getShotList is not a function。这正好击穿原 playbook 的假设 —— 后端 python -c "import app" 会当场 ImportError 炸掉，前端不会。Vue2 项目的 .vue 模板里更隐蔽：模板引用了不存在的组件/方法名，连 warning 都没有，只是渲染成空。
  - 怎么办：① CI 里把警告当失败：npx vue-cli-service build 2>&1 | tee /tmp/b.log; grep -q "was not found in" /tmp/b.log && exit 1；② eslint 开 import/named + import/default（需 eslint-plugin-import 并配好 webpack resolver 才认得 @ 别名，否则会大面积误报，属 version-dependent）；③ 模板侧靠 vue/no-undef-properties + vue/no-unused-components 补位；④ 收尾必须做一次真渲染验证（走一遍改动涉及的页面），不能只看构建成功。

- **Vue2 生态版本号分叉，装错大版本的表现是「一堆莫名其妙的报错或静默不工作」，不是清晰的不兼容提示** `[version-dependent]`
  - 为什么：同名包的高版本大多已只支持 Vue3：@vue/test-utils 2.x（mount 直接报错/API 全变，v1 才有 createLocalVue、propsData、destroy()）、vue-router 4.x、vuex 4.x、vue-jest 5.x/@vue/vue2-jest、eslint-plugin-vue 的 vue3-* 预设（会把正常的 Vue2 写法报成 deprecated，同时漏掉真问题）、vue-tsc 需要 vueCompilerOptions.target=2.7 且只在 Vue 2.7 有意义。最刺人的是 vue-template-compiler：它必须与 vue 完全同一个版本号，npm install vue 单独升了小版本就会在构建时报 "Vue packages version mismatch"（vue-loader@15 会校验），或在没有校验的路径上产生诡异的模板编译差异。
  - 怎么办：锁版本并在 CI 前置断言：node -e "const a=require('vue/package.json').version,b=require('vue-template-compiler/package.json').version;if(a!==b){console.error('mismatch',a,b);process.exit(1)}"；升 vue 时同步 npm i vue@X.Y.Z vue-template-compiler@X.Y.Z；package.json 里对 vue-router/vuex/@vue/test-utils 用精确版本或 ~ 而不是 ^ 跨大版本；新增依赖前先看它的 README 是否标注 Vue 2 支持分支。

- **用 rsync --delete 全量覆盖 dist，会让「已经打开页面的用户」当场坏掉 —— 这就是前端版的「重启中断在途工作」** `[confident]`
  - 为什么：前端没有进程要重启，很容易得出「部署零中断」的错误结论。实际上用户浏览器里那份旧 index.html 引用的是旧 hash 的 chunk，--delete 把旧文件清了之后，他一点懒加载路由就是 Loading chunk chunk-2d0e.abc123.js failed，页面卡在空白且不会自愈；不点路由的人则一切正常 —— 于是变成「只有部分用户报障、我这边刷新就好」的幽灵 bug。如果 index.html 还被 CDN/浏览器缓存了较长时间，这个窗口能持续几十分钟到几天。
  - 怎么办：发布策略二选一：① 同 docroot 叠加 rsync（不加 --delete）+ find -mtime +30 -delete 定期清理；② releases 目录 + symlink，但把 /js /css 通过 Alias 指向累积的共享目录。两者都要配上 index.html 的 Cache-Control: no-store 和 router.onError 里的 ChunkLoadError → window.location.reload() 兜底。发布后的验证要专门覆盖这条：部署前开一个页面别刷新，部署后在该页面上点一次懒加载路由，确认不是白屏。
