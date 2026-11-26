# DESIGN：维护工作流

- 本文档状态：DONE
- 覆盖范围：运维命令的执行位置、迁移、后台任务、存储盘点、备份恢复与故障排查
- 非权威文档引用：`SID#1.4.AGENT-DESIGN`（OSS 权限配置、备份恢复与故障排查）

## 在哪里执行

本地源码仓库使用 `pnpm`，须已安装依赖并准备 `.env.dev` 或 `.env.prod`。下文 `<env>` 替换为 `dev` 或 `prod`；`:<env>` 后缀只是决定命令的目标环境，命令实际仍在当前机器运行。

生产运行镜像使用 `node` 执行已打包工具，不能像源码仓库一样跑 pnpm 脚本。目前只有迁移、存储专项盘点及部署内部使用的 `release.mjs` 被打包；后台状态、独立 worker、样本导出和预热检查仍须在具备源码、依赖及与生产服务连接的环境运行。

环境变量修改方式见 `SID#1.1`；ESA 发布、维护发布和应用回退方式见 `SID#1.3`。

## 源码命令

| 场景 | 怎么做 | 说明 |
| --- | --- | --- |
| **迁移** |||
| 查看迁移状态 | `pnpm migrate:<env> --status` | 核对目标数据库和待执行迁移的版本 |
| 预演迁移 | `pnpm migrate:<env> --dry-run` | 只读查看迁移计划 |
| 检查迁移是否需要维护模式 | `pnpm migrate:<env> --preflight` | 生产部署流程会自动执行此检查 |
| 执行开发迁移 | 普通迁移用 `pnpm migrate:dev`；维护迁移加 `--maintenance` | 维护迁移前停止应用（手动）及其他写入（手动），数据库保持运行 |
| 执行生产迁移 | 普通迁移随应用启动执行；维护迁移按 `SID#1.3` 运行 Maintenance Deploy | 维护前须停止外部 worker、cron，并提供 `plan_id`，见 `SID#1.3` |
| **后台任务** |||
| 查看后台任务 | `pnpm background:status:<env>`；加 `--storage-findings` 查看存储审计异常 | 只读查询数据库账本 |
| 运行独立 worker | `pnpm background:worker:<env>` | 仅在 `app.backgroundRunner.mode=worker` 时使用，会实际执行业务任务 |
| OSS 专项盘点 | `pnpm storage:inventory:<env> --parts --output .data/oss-inventory-<env>` | 只读数据库和 OSS；加 `--metadata-only` 可仅查 OSS |
| **开发** |||
| 检查 ESA 预热 | `pnpm content:preload:check:<env>` | 只读查询 ESA 预热额度、缓存配置和预热账本 |
| 导出数据库样本 | `pnpm db:dump:<env> > sample.sql` | 直连时本机需安装 `mysqldump`；导出时会脱敏：替换手机号、bcrypt 哈希及 IPv4，故不能作为恢复备份 |
| 清空蠢猪档案 | 先运行 `pnpm content:reset:dev` 盘点并核对范围，确认后加 `--apply` 执行；若数据库已重建、无法作为扫描参考，盘点和执行时均加 `--all-content-objects`，改为全量扫描对象；对象清理中断后，加 `--manifest=<清理记录路径>` 续跑 | 仅提供 dev 入口；`--apply` 先清空数据库，再清理对象，清理记录保存在 `.nuxt/content-reset/`；续跑时使用工具输出的记录，不要重新执行数据库清空 |

『导出数据库样本』默认按对应环境配置直连数据库；设置 `MYSQL_CONTAINER` 后，改用当前 Docker 上下文中指定 MySQL 容器执行 `mysqldump`。

## 生产服务器操作

以下命令在包含 `docker-compose.yml` 和 `.env.prod` 的部署目录执行。

### 迁移查询

```sh
docker compose --env-file .env.prod ps
docker compose --env-file .env.prod logs --tail 100 app emqx
docker compose --env-file .env.prod run --rm --no-deps app node /app/.output/server/maintenance/migrate.mjs --status
```

- 最后一条使用一次性容器，即使应用未启动也能查询；退出后删除该临时容器。应用容器正常运行时，也可将 `run --rm --no-deps` 换成 `exec`，复用现有容器；
- 将 `--status` 换成 `--dry-run` 或 `--preflight` 可做只读预演（见上文表）；

### OSS 专项盘点

先按 `SID#1.4.AGENT-DESIGN` 准备独立盘点用户，将其 AccessKey 注入当前终端的 `ALIYUN_OSS_ACCESS_KEY_ID` 和 `ALIYUN_OSS_ACCESS_KEY_SECRET`。

随后可通过以下命令将报告和断点保存到宿主机：

```sh
: "${ALIYUN_OSS_ACCESS_KEY_ID:?请先注入盘点用户的 AccessKey ID}"
: "${ALIYUN_OSS_ACCESS_KEY_SECRET:?请先注入盘点用户的 AccessKey Secret}"
mkdir -p .data/oss-inventory-prod
docker compose --env-file .env.prod run --rm --no-deps \
  -e ALIYUN_OSS_ACCESS_KEY_ID -e ALIYUN_OSS_ACCESS_KEY_SECRET \
  -v "$PWD/.data/oss-inventory-prod:/inventory" \
  app node /app/.output/server/maintenance/storage-inventory.mjs --parts --output /inventory
```

- 如需断点续跑，尽量重复原命令；
- 切换目标、扫描参数或 `--metadata-only` 模式时，应使用新的输出目录。

## 备份恢复与故障排查

见 `SID#1.4.AGENT-DESIGN`。
