# 命令与脚本清单

事实源：[package.json](../../package.json)、[scripts](../../scripts/)、[Check](../../.github/workflows/check.yml)、[Deploy](../../.github/workflows/deploy.yml)、[Dockerfile](../../Dockerfile)。本页说明用途与调用关系，具体操作步骤由对应模块手册维护。

2026-10-25 盘点：package.json 共 **31 个入口**，其中 2 个是安装钩子；scripts 共 **60 个文件**，其中 25 个是测试、1 个是类型声明、1 个是 tsconfig、1 个是目录说明，剩余 32 个也包含内部模块。文件数量不等于需要手动记住的命令数量。

已将 ESA 入口改为 `esa:deploy:dev` / `esa:deploy:prod`，并完成 scripts 按职责分目录，更新内部 import、子进程、CI、Compose 和维护打包路径。其余 pnpm 命令名保持原样；下述命令删减、改名及实现合并仍为**待实施建议**。

## package.json 全部入口

下表均省略 `pnpm` 前缀。环境通过命令中固定参数、进程 `NODE_ENV` 或通用 `--env` 选择；不能仅看命令名猜测实际目标。

| 命令 | 当前用途、边界 | 整理建议 |
| --- | --- | --- |
| `dev` | 启动 Docker 依赖，再启动 Nuxt、授权代理和 frpc；退出只清理本次拥有的应用/通道进程 | 保留为日常默认入口 |
| `dev:app` | 只启动 Nuxt，不启动 Docker 或授权通道 | 保留为局部调试入口 |
| `dev:tunnel` | 给已有应用启动授权代理和 frpc，不启动 Nuxt | 保留；可直接调用 dev/frp.ts，删除薄包装 |
| `dev:auth:prepare` | 生成 frpc 配置和 CA 文件，不启动隧道 | 可并入隧道入口的 `--prepare`；正常启动和 verify 都已包含这一步 |
| `dev:auth:verify` | 先 prepare，再核对 frpc 版本和原生配置；不验证真实授权下载 | 可并入隧道入口的 `--check`，无需单列一个 pnpm 命令 |
| `build` | 使用 `.env.prod` 构建 Nuxt 服务端产物；Docker 构建会调用 | 保留 |
| `preview` | 本机以 `.env.prod` 预览已构建产物；不是生产服务器启动入口 | 保留为交付排查入口 |
| `generate` | Nuxt 静态生成 | 当前 Node/Nitro 交付未使用，仓库未发现调用方；建议删除此命令，保留 build |
| `maintenance:build` | 先生成 settings，再打包迁移执行器、旧存储盘点器、TS 迁移和 Sharp 运行依赖到 `.output` | 保留；Docker 和产物测试正在调用 |
| `env:build` | 按参数或 NODE_ENV 选环境，未设置时默认 dev，合成 env 并保留已填值 | 与两个显式入口重复，建议删除裸入口 |
| `env:build:dev` | 固定合成/补全 `.env.dev` | 保留 |
| `env:build:prod` | 固定合成/补全 `.env.prod` | 保留 |
| `env:encrypt` | 将 `.env.prod` 加密为 `.env.prod.gpg` | 保留；与 decrypt/check 已共用实现 |
| `env:decrypt` | 将 `.env.prod.gpg` 解密为 `.env.prod` | 保留，注意覆盖本机目标文件 |
| `env:check` | 解密到临时文件，与本机 `.env.prod` 按字节比较；密文提交钩子调用 | 保留；文案可明确为“检查密文同步”，不是检查配置是否有效 |
| `settings:generate` | 根据 app-settings/schema 生成浏览器安全常量和类型 | 保留；配置变更、维护构建使用 |
| `settings:check` | 检查上述生成文件是否过期，CI 使用 | 保留；检查与写文件的职责明确 |
| `esa:deploy:dev` | 固定 dev YAML/env，自动同步函数变量、创建版本、发布并读回；`--plan` 离线、`--check` 只读 | 已改，保留 |
| `esa:deploy:prod` | 固定 prod YAML/env，同一发布实现；Deploy 在应用健康后调用 | 已改，保留 |
| `migrate` | SQL/TS 统一版本链；`--status` 状态、`--dry-run` 预演，默认执行，维护步骤需 `--maintenance` | 保留一个实现；写入目标应明确指定环境，不拆回多套业务迁移命令 |
| `background:worker` | 独立进程运行后台任务；要求 `app.backgroundRunner.mode=worker` | 保留；当前精简生产镜像未打包此入口，不能据此认为容器已有 worker 命令 |
| `background:status` | 查询领域账本及全桶对账进度；`--storage-findings` 附带当前目标前 100 个未关闭异常 | 保留；查询和执行保持分开，不另设 cron |
| `content:preload:check` | 查 ESA 额度、分层缓存、配置与预热账本；`--policy` 只输出建议 RAM 策略，不提交预热任务 | 保留；后续将 policy 分支改为只加载 ESA 配置，避免要求无关 DB/应用参数 |
| `storage:cleanup` | **旧 S3 存储只读盘点**，报告孤儿对象、暂存、multipart、头像等；`--delete` 已拒绝执行 | 建议改为 `storage:audit`，显式说明 legacy 范围；当前不是新 Aliyun OSS 全量审计器 |
| `db:dump:dev` | 从所选库导出开发用 SQL，仅替换手机号、bcrypt 和 IPv4，可 `--gzip` | 建议改为 `db:export-sample`；名字中的 dev 目前是导出用途，不固定源库，容易误解 |
| `content:dev:reset` | 开发 Content 重置，默认盘点；`--apply` 执行删除，支持清理记录续跑 | 建议改为 `content:reset:dev`，真正固定 dev 参数；继续保留环境/库/桶保护 |
| `lint` | 全仓库 ESLint 检查 | 保留 |
| `lint:fix` | ESLint 检查并修复 | 可用 `pnpm lint --fix` 替代，删一个纯别名 |
| `test` | Vitest 单次执行，可追加文件或筛选参数 | 保留 |
| `postinstall` | 安装后的 Nuxt prepare，生成类型及框架中间文件 | 安装钩子，保留；不作为日常手动步骤 |
| `prepare` | 安装 simple-git-hooks | 安装钩子，保留；与 Nuxt prepare 含义不同 |

开发用法见[本地开发](README.md)，配置见[环境分层](../deployment/configuration.md)，发布见[ESA](../deployment/esa-functions.md)，迁移见[迁移工具](../operations/migrations.md)。

目前 CI 还直接运行 `pnpm exec nuxt typecheck` 对应的检查（工作流中仍写为 `npx nuxt typecheck`）和 `pnpm exec tsc --project scripts/tsconfig.json --noEmit`，package.json 没有统一 `typecheck` 入口。建议增加一个同时执行两者的 `typecheck`，让本地与 CI 使用同一命令。

## scripts 逐项职责

路径均相对 `scripts/`。测试留在被测模块旁，归类时一起移动。

| 文件 | 职责与实际调用方 | 能否删除/合并 |
| --- | --- | --- |
| [`dev/cli.ts`](../../scripts/dev/cli.ts) | 组合启动、端口检查、应用和隧道生命周期；由 `dev` 调用 | 保留 |
| [`dev/frp.ts`](../../scripts/dev/frp.ts) | 生成/校验 frpc 配置、启动代理和 frpc、回调连通检查、信号处理；dev/cli.ts 与诊断命令共用 | 保留作为隧道的共同实现 |
| [`dev/auth-config.ts`](../../scripts/dev/auth-config.ts) | 解析开发通道 YAML，生成无明文 token 的 frpc 配置模板 | 保留；不是额外启动入口 |
| [`dev/process.mjs`](../../scripts/dev/process.mjs) | 受控子进程重启与清理，dev/frp.ts 调用 | 可转为 TS，和下面的手写声明合为一个文件 |
| [`dev/process.d.mts`](../../scripts/dev/process.d.mts) | 上述 MJS 的 TypeScript 声明 | 实现转为 TS 后删除，不先单独删除 |
| [`dev/auth-proxy.mjs`](../../scripts/dev/auth-proxy.mjs) | 仅转发 POST 授权回调的本地 HTTP 代理，由隧道管理器启动为子进程 | 保留进程边界；当前已通过 tsx 加载，可统一为 TS |
| [`dev/tunnel.mjs`](../../scripts/dev/tunnel.mjs) | 仅调用 dev/frp.ts 的运行/信号函数并报告异常 | dev/frp.ts 已有等价 CLI，可删除此包装并更新命令 |
| [`env/build.ts`](../../scripts/env/build.ts) | 环境模板合成、已有值保留、必填值交互；3 个 env:build 入口共用 | 保留；无需为 dev/prod 复制实现 |
| [`env/gpg.ts`](../../scripts/env/gpg.ts) | encrypt/decrypt/check 共用 GPG、口令和临时文件逻辑 | 保留；3 个动作无需强行变成一个名字 |
| [`env/preload.mjs`](../../scripts/env/preload.mjs) | 在 CLI 业务模块导入前选择并注入 env、移除环境参数 | 保留原生 MJS 预载边界，不能简单改成依赖 Nuxt 的加载器 |
| [`background/worker.ts`](../../scripts/background/worker.ts) | 独立 worker 适配器注册、保活、退出清理 | 保留 |
| [`background/status.ts`](../../scripts/background/status.ts) | 领域账本状态查询及 DB 关闭 | 保留 |
| [`content/preload-check.ts`](../../scripts/content/preload-check.ts) | 预热状态/额度/分层缓存检查及 RAM policy 输出 | 保留，按内容预热归属 content/ |
| [`storage/audit.ts`](../../scripts/storage/audit.ts) | 旧 S3 只读盘点；package 命令及 maintenance build 都引用 | 不能当无调用方删除；旧源全部退役后再评估去除 |
| [`db/export-sample.ts`](../../scripts/db/export-sample.ts) | mysqldump 流式替换及可选 gzip；db:dump:dev 调用 | 保留；需补明确源库/容器选择，并修正 pnpm 命令的误导命名 |
| [`content/reset-dev.ts`](../../scripts/content/reset-dev.ts) | 开发重置盘点、保护条件、数据库清除和对象清理续跑 | 保留；不并入日常迁移或普通清理 |
| [`migration/maintenance-build.ts`](../../scripts/migration/maintenance-build.ts) | 只调用 migration/build.ts 的 build_maintenance | 可将 CLI 入口放进 build.ts 后移除薄包装；保持 production 产物合同 |
| [`migration/local.ts`](../../scripts/migration/local.ts) | 本地迁移入口：先构建冻结 TS 产物，再调用共同执行器 | 与容器入口有真实差异，不可简单删掉构建步骤 |
| [`migration/cli.ts`](../../scripts/migration/cli.ts) | 共同参数解析、信号取消、脱敏错误；也是容器打包的执行入口 | 保留，与本地入口共用逻辑但保留预构建产物边界 |
| [`migration/runner.ts`](../../scripts/migration/runner.ts) | 数据库锁、账本、SQL/TS 执行、维护门、checkpoint 和失败处理 | 核心实现，保留 |
| [`migration/catalog.ts`](../../scripts/migration/catalog.ts) | 版本文件发现、摘要验证、计划和冻结产物加载 | 保留 |
| [`migration/contract.ts`](../../scripts/migration/contract.ts) | TS 迁移上下文及 define_migration 合同 | 保留；版本化迁移依赖它，整理不得改坏冻结摘要 |
| [`migration/build.ts`](../../scripts/migration/build.ts) | 冻结 TS bundle/manifest 与 maintenance 产物构建 | 保留；可吸收 migration/maintenance-build.ts 的 CLI 包装 |
| [`migration/native.ts`](../../scripts/migration/native.ts) | Sharp 等原生依赖打包、身份和完整性清单 | 保留；生产镜像内图片迁移需要 |
| [`verify/migration-runtime.ts`](../../scripts/verify/migration-runtime.ts) | 独立数据库中验证执行、恢复、冻结、容器产物等合同；Check 调用 | 保留为集成验证，不包装成日常应用命令 |
| [`verify/content-migration.ts`](../../scripts/verify/content-migration.ts) | 独立数据库验证 Content 转换，默认内存 OSS，显式参数可走真实开发对象存储；Check 调用默认模式 | 保留；与普通单测、生产迁移的职责不同 |
| [`verify/css-cascade-feasibility.ts`](../../scripts/verify/css-cascade-feasibility.ts) | 通过现有依赖诊断 CodeMirror / PrimeVue 的样式入口；`pnpm exec tsx scripts/verify/css-cascade-feasibility.ts`，不加载应用配置或接入转换；输出与限制见[可行性评估](../reviews/css-layer-public-api-feasibility-2026-10-29.md) | 保留为独立探针；成功退出不代表动态适配或旧浏览器兼容验收通过 |
| [`esa/cli.ts`](../../scripts/esa/cli.ts) | 发布命令入口、目标输出、本机锁与脱敏记录 | 保留，两环境共用 |
| [`esa/config.ts`](../../scripts/esa/config.ts) | 专用 YAML/env 校验、变量映射、脱敏 plan | 保留 |
| [`esa/api.ts`](../../scripts/esa/api.ts) | 发布所需 ESA API 传输与错误脱敏 | 保留 |
| [`esa/commit.ts`](../../scripts/esa/commit.ts) | 调用锁定官方 CLI，隔离上传源码和发布凭据，解析本次版本 | 保留独立边界 |
| [`esa/deploy.ts`](../../scripts/esa/deploy.ts) | 路由/变量/版本检查、同步与发布编排、不确定结果核对 | 保留；不要为减少文件把所有层塞入 cli.ts |
| [`deploy/remote.sh`](../../scripts/deploy/remote.sh) | GitHub 经 SSH 传入生产主机；切换 env/Compose/镜像、健康门、失败恢复 | 保留 shell，当前不需要额外本地 pnpm 入口 |
| [`dev/emqx-entrypoint.sh`](../../scripts/dev/emqx-entrypoint.sh) | 开发 EMQX 容器初始认证用户文件生成和原入口转交；Compose 挂载 | 保留 shell，不应与应用部署脚本合并 |
| [`tsconfig.json`](../../scripts/tsconfig.json) | scripts 与版本化 TS 迁移的独立类型检查项目及 aliases | 保留，和 Nuxt tsconfig 的职责不同 |
| [`README.md`](../../scripts/README.md) | 目录职责索引，链接回本清单 | 保留，避免在入口说明中复制操作手册 |

25 个 `*.test.ts` 均是测试，不是运维命令。其中 [`verify/package.test.ts`](../../scripts/verify/package.test.ts)、[`deploy/docker-image.test.ts`](../../scripts/deploy/docker-image.test.ts)、[`verify/nuxt-config.test.ts`](../../scripts/verify/nuxt-config.test.ts)、[`migration/maintenance-build.test.ts`](../../scripts/migration/maintenance-build.test.ts) 检查跨文件接线/产物，其余主要跟随相应模块。[`migration/sql.test.ts`](../../scripts/migration/sql.test.ts)、[`catalog-sql.test.ts`](../../scripts/migration/catalog-sql.test.ts)、[`frozen.test.ts`](../../scripts/migration/frozen.test.ts) 分别保护 SQL 执行/失败/幂等、版本识别及历史不可变合同。不要为了减少列表长度删掉这些测试。

迁移实现位于 `migrations/`，scripts/migration 是运行工具。历史迁移与其冻结闭包不得改名、改内容或重新生成摘要来掩盖变化，见[迁移约束](../../.github/instructions/migrations.instructions.md)。

官方 CSS API 的隔离浏览器验证使用 `pnpm exec playwright test --config tests/css.config.ts`，不经过应用服务器和数据库 setup；报告位于 `.dev/css-official-apis/`，验证范围见[评估记录](../reviews/css-official-apis-validation-2026-10-29.md)。它不是 `pnpm test:e2e` 完整应用验收的替代品。

真实生产 CSS 构建验收使用 `pnpm exec playwright test --config tests/css-production.config.ts`，保留 legacy、生产 Browserslist、压缩及分块，创建并清理独立 E2E 数据库。编译配置和资产报告在 `.dev/e2e/<run>/css-build.json`，浏览器报告在 `.dev/css-production/`；详见[生产一致性验收](../reviews/css-production-parity-2026-10-29.md)。

## 建议的整理顺序

### 第一批：减少重复入口，修正误导命名

1. 删除 `generate`、裸 `env:build`、`dev:auth:prepare`、`dev:auth:verify`、`lint:fix` 共 5 个入口；隧道入口承接准备/校验参数，其他已有替代入口。
2. 将 `storage:cleanup` 改名 `storage:audit`，`db:dump:dev` 改名 `db:export-sample`，`content:dev:reset` 改名 `content:reset:dev`。同步调用方与文档，不增加永久兼容别名。
3. 增加 `typecheck` 合并现有两条类型检查，并把 Check 中的 npx 改为统一 pnpm 入口。
4. 这样 package.json 从 31 个变为 **27 个入口**；这是建议后的数量，当前尚未执行此批整理。

### 已完成：按职责收拢 scripts

当前布局：

```text
scripts/
  dev/         # 组合启动、隧道、代理、子进程管理、开发容器入口
  env/         # 模板合成、GPG、预载
  db/          # 开发样本导出
  storage/     # 旧存储盘点
  content/     # 开发重置、预热诊断
  background/  # 独立 worker、状态查询
  deploy/      # 远端部署 shell
  esa/         # 保持现有分层
  migration/   # 版本链工具、本地/容器入口及构建
  verify/      # CI 集成验证
  README.md
  tsconfig.json
```

已移动 36 个文件，测试随模块移动，目录内去掉重复的职责前缀。pnpm 入口、CI/Compose、模块导入、子进程和维护打包路径均已更新。版本化迁移及其冻结依赖未移动。

后续仍可删除 dev/tunnel.mjs 薄包装；也可让 migration/maintenance-build.ts 的入口归入构建模块，或将 dev/process.mjs 转 TS 后去掉手写 `.d.mts`。这些实现合并尚未执行。

### 统一规则

- 命令以“领域:动作”为主；如使用 `:dev` / `:prod`，它只表示实际操作环境并且必须固定传给加载器，不能表示产物用途。发布命令保留两条便利入口；只读查询仍可共用 `--env`，避免把每个诊断都翻倍成两条命令。
- 对同一目标的 plan/check/apply 使用参数区分，别为每一步都再新增 pnpm 名字。迁移已使用 `--dry-run` 和 `--status`，迁移语义保留，不能硬改成与 ESA 完全相同的步骤。
- 同一领域共用实现和配置加载器，不建立新的“大而全脚本 runner”；后台任务 runner 和一次性运维 CLI 是不同生命周期。
- 带写入的运维入口在实际执行前显示环境/目标；查询、预演不得先启动 worker 或执行业务变更。`--help` / policy 只加载必要配置，不依赖无关应用凭据。
- stdout 用于结构化结果或导出内容，stderr 用于进度和脱敏错误；拒绝未知参数。所有工具统一主入口识别与退出清理，避免依赖 Windows 路径字符串形式。
- 样本导出需额外改进：显式选择源库和可选 Docker 容器，不自动优先选固定的 `1Panel-mysql`；输出文件显式指定，补真实入口的跨平台验证。当前正则替换不等于完整隐私脱敏，也不能作为恢复备份。
- 变动入口时同步 package、工作流、Docker/Compose、文档、子进程路径与测试；只检查“文件存在”不足以证明执行接线正确。ESA 新测试已从实际 package recipe 启动隔离夹具。

## 本次核对范围

共享草稿的新增一次性验证入口是 `pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/cloud-drafts.ts --mqtt --capacity`，复用现有迁移工具与随机本地库；没有新增常驻任务或 pnpm 别名。`--mqtt` 启动自己的临时 broker，`--capacity` 记录有界负载；作用域及外部服务替身见[测试手册](testing.md)。

已读取源码及仓库调用关系，未执行数据库导出、清理/重置、迁移或云端发布。仓库外的定时任务、1Panel 手工命令和个人终端历史不在搜索范围；上述“未发现调用方”仅指仓库内部。
