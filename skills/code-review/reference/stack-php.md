# PHP 后端 · 命令映射

> **状态**：本机未安装 PHP，本文所有命令一条都没有实际运行过；因此全部置信度标签一律按 `[version-dependent]` 处理。首次用到某条先在自己项目里验一次。事实核查的修正已并入正文，以正文为准。

适用：裸 PHP + Laravel / Symfony / CodeIgniter 4。审查用，只给「语法 / 静态 / 加载冒烟 / 逻辑验证」四类动作各最有用的命令。

## 四类动作

### 1. 语法  `[version-dependent]`

```bash
# php -l 只处理第一个文件参数，必须 -n1；靠 xargs 的非零退出码，不要在尾部接 grep（grep 会吞掉/反转退出码）
git ls-files '*.php' | xargs -n1 -P8 php -l >/dev/null
# 只查本次改动
git diff --name-only --diff-filter=ACM HEAD | grep '\.php$' | xargs -r -n1 php -l
```

- 这条抓不到什么：只抓 parse error；不存在的类、拼错的方法/变量名、参数个数错全抓不到，不能当「检查通过」。
- 模板不在覆盖范围：Blade 需 `php artisan view:cache` 后再对 `storage/framework/views` 编译产物 `php -l`（view:cache 本身只抓少量指令层错误）；Symfony 用 `php bin/console lint:twig templates`。

### 2. 静态  `[version-dependent]`

```bash
composer require --dev phpstan/phpstan larastan/larastan   # Laravel；Symfony 换 phpstan-symfony phpstan-doctrine
vendor/bin/phpstan analyse --memory-limit=1G               # phpstan.neon: level 6；存量项目加 --generate-baseline 只看新引入的
```

- 这条抓不到什么：未使用的局部变量/参数 PHPStan 任何 level 都不报（需 Psalm `findUnusedVariablesAndParams`）；不装框架扩展会被 Facade/`__get` 假阳性淹没。未定义名 level 0-2 可抓，类型/null 需 level>=6。

### 3. 加载冒烟  `[version-dependent]`

```bash
php -r 'require "vendor/autoload.php"; var_dump(class_exists("App\\Services\\FooService", true));'  # PSR-4 路径/大小写错在这里现形
# Laravel：config:cache / route:cache 能暴露 config、路由里的闭包；用完 optimize:clear 清掉
php artisan config:cache && php artisan route:cache; php artisan optimize:clear
php artisan list | grep -q ' about ' && php artisan about   # about 仅 Laravel 9+，先探测再跑，否则旧版以「Command about is not defined」非零退出，像应用加载失败
# Symfony：最接近循环依赖检查
php bin/console lint:container --env=prod
```

- 这条抓不到什么：PHP 是 share-nothing，每请求重新 bootstrap，冒烟只证明「能加载」，证明不了单例/初始化顺序；类循环依赖在 PHP 合法，真会炸的是 Symfony DI 循环与 legacy require 环。

### 4. 逻辑验证  `[version-dependent]`

```bash
# phpunit.xml: DB_CONNECTION=sqlite、DB_DATABASE=:memory:、QUEUE_CONNECTION=sync、MAIL_MAILER=array、SESSION_DRIVER=array
# 缓存两行都写：CACHE_DRIVER=array（Laravel <=10）与 CACHE_STORE=array（11+），写错的那行静默不生效
php artisan config:clear && php artisan test --testsuite=Unit
# 测试内必须伪造外部依赖：Http::fake(); Mail::fake(); Notification::fake(); Queue::fake(); Bus::fake(); Event::fake(); Storage::fake('s3');
```

- 这条抓不到什么：`:memory:` SQLite 对 MySQL 专属 SQL（JSON 函数/FULLTEXT/ON DUPLICATE KEY）会假绿，每连接独立；缺任一个 fake 就会真发邮件/真调第三方。用 MySQL 时另建 `phpunit.mysql.xml` 并用 `-c` 指定，别只给 migrate 带环境变量。
- 裸 PHP 若到处 `new PDO(...)` 硬编码 DSN，隔离环境做不出来，要如实说「这条暂时不可用」，别写假通过。

### 本栈审查维度重点清单（替换 playbook 里 DIMS 的 focus）

- PSR-4 命名空间与文件路径/大小写是否严格一致：macOS/Windows 大小写不敏感，本地全绿、Linux 生产 500 "Class not found"，php -l 完全抓不到，只有真实加载或 PHPStan 会现形
- 严格类型与松散比较：新增/改动文件有没有 declare(strict_types=1)；== / in_array 的松散比较、empty() 对 "0"/0/[]/null 的语义差异、null 传进非可空参数（PHP 8 起是 TypeError 而不再是 warning）
- 本次改动是否触碰任何"必须重建才生效"的缓存层：config/*.php、routes、Blade 视图、event、Symfony DI 容器、composer classmap——发布脚本里有没有对应的重建步骤
- 改动落在"每请求重建"的代码还是"常驻进程"的代码：Job / Listener / Console Command / Octane 需重载进程才生效；特别是 Job 的构造函数签名或属性有没有变（队列里已有的旧 payload 会反序列化失败）
- 迁移是否向后兼容（expand-contract）：滚动发布期间新旧代码同时在跑，两边都得能用；大表 DDL 的锁表时长；down() 是否真的被执行验证过
- 输入面与注入：$request->all() 直灌 Model::create/update（$fillable/$guarded 是否收紧）、whereRaw/DB::raw/字符串拼 SQL、Blade 的 {!! !!}、unserialize()/extract() 吃用户输入、上传文件的 mime 与扩展名校验
- ORM 访问模式与资源上限：Eloquent/Doctrine 的 N+1（循环里 lazy load）、缺 with()/fetch join、->get() 拉全表 vs chunkById()/cursor()、memory_limit 与 max_execution_time 够不够
- 错误可见性与发布残留：生产 APP_DEBUG=false、异常处理有没有把栈泄漏给用户、@ 抑制符、catch (\Throwable) {} 静默吞异常、dd()/dump()/var_dump()/error_log 调试残留、storage/ 与 bootstrap/cache 的属主和写权限（root 创建 + www-data 运行 = 500）

### 本栈特有的坑

- **改了 Job / Message 的构造函数签名或属性，队列里积压的旧任务会全部失败** `[version-dependent]`：Laravel/Symfony 把 job 序列化成 payload 存进队列，新代码反序列化旧结构 payload：少了属性是 undefined property，构造参数数量变了是 ArgumentCountError，重试后进 failed_jobs。审查时看到签名/属性变更就要提出：不改老类，新建 Job 类并让旧类保留一个发布周期；必须加属性就给默认值并做双读兼容。
