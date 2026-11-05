# MySQL 与 Redis

入口：[数据库连接](../../server/lib/db.ts)、[Redis 连接](../../server/lib/redis.ts)、[开发 Compose](../../docker-compose.dev.yml)。生产 Compose 部署应用和专用 EMQX；MySQL、Redis 仍由服务器环境独立维护。

## MySQL

开发和 CI 使用 MySQL 8.4。生产升级数据库版本前应以同版本副本重放迁移和执行业务验收，不能仅依据驱动支持判断 schema 兼容。

| 项目 | 当前要求 |
| --- | --- |
| 连接 | `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` |
| 编码 | 开发初始化为 utf8mb4 / utf8mb4_unicode_ci；具体字段/索引以迁移链为准 |
| 时区 | mysql2 使用 `timezone: Z`，每条物理连接执行 `SET time_zone = "+00:00"` |
| 池 | 当前每个应用进程最多 10 个连接；另计 worker 和维护工具 |
| schema | 只由 `migrations/` 按文件名顺序演进；唯一账本为 `migration_runs` |
| 数据 | 会话、正文、附件、上传与后台任务账本都在 MySQL，不能按缓存处理 |

创建空业务库和专用账号，使其能连接目标库。现行容器启动会执行 SQL 迁移，因此运行身份不仅需要普通 CRUD，还需要本版本迁移实际使用的 DDL 权限。若要把迁移身份和运行身份进一步分离，需要调整启动流程；仓库目前没有自动实现这一分离。

旧库需保存一致性数据库备份，并按[迁移工具](../operations/migrations.md)检查状态、预演和维护执行。禁止编辑旧迁移或手工把失败状态改成 completed。已有生产 Content 的切换另见[操作手册](../operations/content-cutover.md)。

Docker 数据目录应持久化并进入备份策略。开发使用命名卷 `mysql-data`，删除卷会删除数据；修改 env 中初始化密码不会自动修改一个已经初始化的 MySQL 实例账号。

## Redis

配置为 `REDIS_HOST/PORT/PASSWORD`；生产根据服务实际身份填写，开发层覆盖为空密码。客户端延迟连接，单次请求最大重试 1 次；错误记录 warning。旧 Bilibili 元数据接口退役后，当前仓库没有其他业务 Redis 读写；连接模块、后台 worker 的客户端引用和部署配置仍保留。

```text
业务数据 / 会话 / 上传与任务状态 → MySQL
旧 Bilibili 元数据缓存           → Redis 历史数据，当前应用不再使用
```

开发 Redis 仅绑定本机回环地址；生产应限制网络访问并配置身份验证。持久化和驱逐配置由运维环境维护，仓库生产 Compose 未声明这些设置；部署时确认其是否可重建、允许的内存和故障降级，避免把业务数据库误指向 Redis 或把 Redis 清理当作任务重置。

### 清理退役的 Bilibili 缓存

先确认新版本已覆盖全部应用与 worker 实例，旧版本不再接收请求，避免缓存再次写入。在目标 Redis 实例及所选数据库中，用 `SCAN` 按 `bilibili:*` 枚举并核对键，再分批 `UNLINK`，最后重新扫描确认。旧成功缓存和冷却状态可能没有 TTL，不能依赖自然过期。无需读取缓存内容，也不要用 `FLUSHDB`／`FLUSHALL` 清空整个实例。共享 Redis 是否包含其他应用的数据需在目标环境确认；本地检查结果不能代表生产。

## 核验

先验证应用容器可以解析并连接 MySQL 的网络地址，再检查 `/healthz` 与业务请求。`/healthz` 只查询 MySQL 迁移账本，不验证 Redis。MySQL 不通会让健康端点返回 503；Redis 连通性应使用运维工具单独核验，当前业务请求成功不代表 Redis 可达。

数据备份、恢复演练、密钥与旧 AES 恢复材料的保存见[备份恢复](../operations/backup-recovery.md)。

## 空库的首个管理员

迁移只建立结构，不自动创建管理员或开发账号；当前没有管理员 bootstrap CLI。先通过正常注册流程创建站点所有者账号，使用可接收验证码的受控号码，生产不能开启 debug 跳过验证。

由获授权的数据库维护人员核对该用户 ID、用户名和手机号，仅将这一条记录的 `is_admin` 改为 1、`permissions` 设为空数组，并读回确认。全局管理员拥有全部权限，不需拼装权限列表。操作留审计，完成后重新登录验证管理页和 Content 权限；已有库保留原身份数据，不重复初始化，也不复制开发账号密码。

依据：[注册实现](../../server/services/auth.service.ts)、[权限规则](../../server/shared/permissions.ts)、[账号模块](../modules/accounts.md)。
