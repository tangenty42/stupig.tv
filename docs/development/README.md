# 本地开发

本页描述工作区启动和日常命令。完整入口、脚本职责与整理建议见[命令与脚本清单](./commands.md)。首次接入先阅读[配置分层](../deployment/configuration.md)，需要真实附件读取时再配置[开发授权隧道](./auth-tunnel.md)。

## 环境

- Node.js 24；CI 使用 pnpm 12.10.1。版本依据是 [Check 工作流](../../.github/workflows/check.yml) 和 [Dockerfile](../../Dockerfile)。
- Docker 与 Compose：开发 MySQL、Redis、EMQX、phpMyAdmin 由 [docker-compose.dev.yml](../../docker-compose.dev.yml) 启动；Nuxt 在宿主机运行。
- EMQX 固定 `emqx/emqx:6.2.2`，与当前生产版本一致；认证、listener 和 ACL 见[MQTT 手册](../deployment/mqtt.md)。
- 当前开发隧道要求 frpc 0.71.0。Windows 默认路径见 [config/dev.yaml](../../config/dev.yaml)，其他平台可自行创建开发专用的 `config/local.yaml` 覆盖可执行文件路径。该本机配置不入库，未创建时不存在是正常情况，见[配置说明](../deployment/configuration.md)。
- 依赖锁文件为 `pnpm-lock.yaml`。首次 `pnpm install` 会运行仓库已有的 Nuxt prepare 和 Git hooks 安装，不需要反复手动 prepare。

## 首次启动

下面是 PowerShell 顺序。开始前确认工作区没有已经运行的应用或独立隧道。

```powershell
pnpm install --frozen-lockfile
pnpm env:build:dev
```

按提示补齐本机 `.env.dev` 中的必填值；未填写的 `<required>` 必须处理后再启动。环境模板包含 shared 和 dev 两层，具体值不要复制进文档、提交记录或截图。开发默认启用 OTP/CAPTCHA 调试；使用测试号码前确认运行中的 OTP 调试确实开启，避免发送真实短信。

先启动依赖，等待 MySQL 可以连接，再初始化数据库：

```powershell
docker compose --env-file .env.dev -f docker-compose.dev.yml up -d
docker compose --env-file .env.dev -f docker-compose.dev.yml ps
$env:NODE_ENV = 'development'
pnpm migrate --status
```

全新开发数据库执行 `pnpm migrate --maintenance`；已有数据先按[迁移手册](../operations/migrations.md)检查待执行步骤和备份需求。`--maintenance` 仅表示允许维护迁移，不能代替停止其他写入。当前完整 Content 迁移也属于维护步骤。

配置 frpc 和回调服务器后执行：

```powershell
pnpm dev:auth:prepare
pnpm dev:auth:verify
pnpm dev
```

`pnpm dev` 会再次确保 Docker 依赖已启动，然后启动 Nuxt、授权专用代理及 frpc。应用端口取 `.env.dev` 的 `APP_PORT`；当前模板为 3042。不要使用 `--port` 临时改变组合启动的端口，否则代理目标与应用会不一致。

启动后会在独立子进程中只读检查开发 ESA 函数的活动版本、路由和非机密变量；检查不会阻塞 Nuxt，也不会发布函数。新发布的开发版本携带源码摘要，可与本地源码比较；旧版本若没有摘要，会尝试读取在线源码，或使用与当前版本和目标精确对应的本机发布记录。均不可用时提示无法核对。源码或配置不一致时，按需手动运行 `pnpm esa:deploy:dev`；网络或权限故障可先用 `pnpm esa:deploy:dev --check` 排查。加密密钥无法只读比对，提示一致也不能代替真实附件读取验证。

## 启停与进程归属

| 操作 | 命令与行为 |
| --- | --- |
| 默认开发 | `pnpm dev`，应用与授权通道一起运行 |
| 仅应用 | `pnpm dev:app`；显式的局部调试入口 |
| 给既有应用补隧道 | `pnpm dev:tunnel`；不要与默认组合入口同时运行 |
| 仅依赖 | `docker compose --env-file .env.dev -f docker-compose.dev.yml up -d` |
| 停止本次应用与通道 | 在启动终端按 Ctrl+C；只清理本入口拥有的进程 |
| 停止依赖，保留数据卷 | `docker compose --env-file .env.dev -f docker-compose.dev.yml stop` |

默认入口遇到应用端口占用会拒绝启动，不会让 Nuxt 自动换端口。代理端口只能复用带 `X-Dev-Auth-Proxy: 1` 标识的既有开发代理，未知进程不会被接管或终止。Ctrl+C 后 Docker 依赖继续运行；被复用的外部代理也不归本次入口清理。

开发 MySQL 使用命名数据卷；不要用删除数据卷的方式解决普通启动错误。当前开发 Compose 的 MySQL、Redis、phpMyAdmin 端口并非全部限制为回环，运行在共享网络的机器上应核对主机防火墙；EMQX 映射已限定回环。

## EMQX 版本与升级

修改镜像版本前先检查官方升级路径、`durable_sessions.enable`、节点身份和实际挂载，导出 broker 数据，并在停止 broker 后备份数据及配置。旧版本备份和镜像应保留到升级验收通过；回退时不能直接让旧镜像使用已被新版本改写的数据。

确认升级条件和备份后，仅更新 EMQX：

```powershell
docker compose --env-file .env.dev -f docker-compose.dev.yml pull emqx
docker compose --env-file .env.dev -f docker-compose.dev.yml up -d --no-deps emqx
docker compose --env-file .env.dev -f docker-compose.dev.yml exec emqx emqx ctl status
```

Compose 重建时保留现有挂载；不要使用 `down -v`、`--renew-anon-volumes` 或删除卷来升级。EMQX 的数据/日志目前由镜像创建的匿名卷承载，重建前后需核对卷身份及节点身份；应用 `.env.dev` 不会覆盖已有 broker 用户密码。

2026-10-24 本机从 5.10.5 升到 6.2.2，升级前确认 durable sessions 关闭，已保存逻辑导出、停机数据/配置与容器元数据，原卷与节点身份保持不变，升级后 MQTT 3.1.1/5 各 10 项权限测试通过。备份位于本机忽略目录 `.data/emqx-upgrade-20261024-6.2.2/`，限制为当前用户访问，不随仓库分发；新检出不依赖它。开启 durable sessions 的其他环境须另外按[官方升级限制](https://docs.emqx.com/en/emqx/v6.2/deploy/rolling-upgrades.html)处理。

## 日常命令

| 命令 | 用途 |
| --- | --- |
| `pnpm env:build:dev` | 更新 `.env.dev` 的结构及开发模板值，保留已有用户配置 |
| `pnpm env:build:prod` | 更新独立的 `.env.prod`；不会切换正在运行的开发应用 |
| `pnpm settings:generate` / `pnpm settings:check` | 生成／检查浏览器安全的共享业务参数 |
| `pnpm lint` | 全仓库风格检查，格式化工具只有 ESLint |
| `pnpm test` | Vitest 单次执行 |
| `pnpm exec nuxt typecheck` | 应用及共享类型检查 |
| `pnpm exec tsc --project scripts/tsconfig.json --noEmit` | 工具与迁移 TypeScript 检查 |
| `pnpm background:status` | 读取后台领域账本状态 |
| `pnpm content:preload:check` | 查询预热额度、分层缓存配置、开关和账本；不代替真实交付验收，先阅读[预热说明](../modules/content/object-lifecycle.md) |

裸 `pnpm env:build` 遵循 NODE_ENV，未设置时默认生成 `.env.dev`；生产使用 `pnpm env:build:prod`。迁移、后台状态和预热工具可用 `--env=prod` 选择 `.env.prod`；ESA 用 `pnpm esa:deploy:dev` / `pnpm esa:deploy:prod` 固定选择环境，不需要复制文件或手动加载 dotenv。Nuxt 构建、生成及维护产物打包不属于日常 HMR 流程；在需要交付产物时按[部署手册](../deployment/README.md)运行。

## 测试数据与重置

开发实例已有 `admin`、`user` 测试身份，是否仍存在以本机数据库为准。优先使用既有会话或密码登录；测试号码不是可以发送真实短信的号码白名单。

`pnpm db:dump:dev` 是从所选数据库导出开发用脱敏 SQL 的工具，当前仅替换手机号、bcrypt 哈希及 IPv4。它不是完整隐私清洗，也不是恢复备份；正文、对象信息、历史迁移恢复材料等仍可能敏感。导出前选择正确环境，受控保存，并按[备份与恢复](../operations/backup-recovery.md)区分用途。

`pnpm content:dev:reset` 是破坏性开发辅助工具，默认先盘点；实际删除需显式执行参数。它不属于安装或故障修复步骤，不应为了让测试通过而清空用户工作区。旧 `storage:cleanup` 只用于旧存储盘点，删除模式已经退休。

## 源码入口

- [组合启动器](../../scripts/dev/cli.ts)、[隧道启动器](../../scripts/dev/frp.ts)。
- [环境生成器](../../scripts/env/build.ts)、[配置加载器](../../config/lib/loader.ts)。
- [测试规范与验收](./testing.md)、[故障排查](../operations/troubleshooting.md)。
