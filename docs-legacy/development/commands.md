# 命令与脚本清单

事实源：[package.json](../../package.json)、[scripts](../../scripts/)、[Check](../../.github/workflows/check.yml)、[Deploy](../../.github/workflows/deploy.yml)、[Dockerfile](../../Dockerfile)。本页说明用途与调用关系，具体操作步骤由对应模块手册维护。

2026-11-01 精简：package.json 从 **38 个入口减少到 33 个**，其中 2 个是安装钩子；先前精简到 34 个后，本轮再移除旧 S3 盘点入口。`check` 是本地与 CI unit job 的共同质量入口，`typecheck` 统一应用、工具和浏览器测试的类型检查。文件数量不等于需要手动记住的命令数量。

ESA 与 scripts 目录整理已完成；本轮合并开发隧道的准备／校验入口，移除重复别名与未使用的静态生成命令。旧存储盘点已删除。2026-11-02 新增 OSS 专项盘点，并按用户选择将有环境目标的源码运维入口统一为 `:dev`／`:prod`；当前共 40 个入口，含 2 个安装钩子。开发重置仅提供 `content:reset:dev`；样本导出默认使用所选环境的地址，容器须显式指定，脱敏边界见下表。

## package.json 全部入口

下表均省略 `pnpm` 前缀，同实现的 dev/prod 入口合并列出。运维后缀固定传给环境加载器，先于依赖导入选择环境；同名进程注入值仍按既有规则优先。无环境目标的构建和测试命令保持原名。

| 命令 | 当前用途、边界 | 整理建议 |
| --- | --- | --- |
| `dev` | 启动 Docker 依赖，再启动 Nuxt、授权代理和 frpc；退出只清理本次拥有的应用/通道进程 | 保留为日常默认入口 |
| `dev:app` | 只启动 Nuxt，不启动 Docker 或授权通道 | 保留为局部调试入口 |
| `dev:tunnel` | 给已有应用启动授权代理和 frpc；`--prepare` 仅生成配置，`--verify` 准备并检查 frpc 版本／配置 | 共用 dev/frp.ts 的 CLI；不启动第二个应用 |
| `build` | 使用 `.env.prod` 构建 Nuxt 服务端产物；Docker 构建会调用 | 保留 |
| `preview` | 本机以 `.env.prod` 预览已构建产物；不是生产服务器启动入口 | 保留为交付排查入口 |
| `maintenance:build` | 先生成 settings，再打包迁移／发布执行器、OSS 专项盘点、TS 迁移和 Sharp 运行依赖到 `.output` | 保留；Docker 和产物测试正在调用 |
| `env:build:dev` | 固定合成/补全 `.env.dev` | 保留 |
| `env:build:prod` | 固定合成/补全 `.env.prod` | 保留 |
| `env:encrypt` | 将 `.env.prod` 加密为 `.env.prod.gpg` | 保留；与 decrypt/check 已共用实现 |
| `env:decrypt` | 将 `.env.prod.gpg` 解密为 `.env.prod` | 保留，注意覆盖本机目标文件 |
| `env:check` | 解密到临时文件，与本机 `.env.prod` 按字节比较；密文提交钩子调用 | 保留；文案可明确为“检查密文同步”，不是检查配置是否有效 |
| `settings:generate` | 根据 app-settings/schema 生成浏览器安全常量和类型 | 保留；配置变更、维护构建使用 |
| `settings:check` | 检查上述生成文件是否过期，CI 使用 | 保留；检查与写文件的职责明确 |
| `esa:deploy:dev` | 固定 dev YAML/env，自动同步函数变量、创建版本、发布并读回；`--plan` 离线、`--check` 只读 | 已改，保留 |
| `esa:deploy:prod` | 固定 prod YAML/env，同一发布实现；Deploy 在应用健康后调用 | 已改，保留 |
| `migrate:dev` / `migrate:prod` | SQL/TS 统一版本链；`--status` 状态、`--dry-run` 预演，默认执行，维护步骤需 `--maintenance` | 同一个实现，后缀固定环境；CI 用 prod 入口保持原生产配置验收 |
| `background:worker:dev` / `background:worker:prod` | 独立进程运行后台任务；要求 `app.backgroundRunner.mode=worker` | 当前精简生产镜像未打包此入口，不能据此认为容器已有 worker 命令 |
| `background:status:dev` / `background:status:prod` | 查询领域账本及全桶对账进度；`--storage-findings` 附带当前目标前 100 个未关闭异常 | 查询和执行保持分开，不另设 cron |
| `content:preload:check:dev` / `content:preload:check:prod` | 查 ESA 额度、分层缓存、配置与预热账本；`--policy` 只输出建议 RAM 策略，不提交预热任务 | 后续将 policy 分支改为只加载 ESA 配置，避免要求无关 DB/应用参数 |
| `storage:inventory:dev` / `storage:inventory:prod` | 只读专项盘点版本、删除标记及 multipart，支持断点／预算和显式纯元数据模式 | 生产另打包 `storage-inventory.mjs`，无需 pnpm；不是清理入口 |
| `db:dump:dev` / `db:dump:prod` | 从对应来源环境导出开发用 SQL，仅替换手机号、bcrypt 和 IPv4，可 `--gzip` | 后缀表示来源环境；默认连接配置地址，仅显式 `MYSQL_CONTAINER` 才改走指定容器，不自动回退 |
| `content:reset:dev` | 开发 Content 重置，默认盘点；`--apply` 执行删除，支持清理记录续跑 | 固定 dev 参数，保留环境/库/桶保护，不提供 prod 入口 |
| `lint` | 全仓库 ESLint 检查 | 保留 |
| `test` | 顺序执行单元、工具和挂载组件测试 | 筛选文件时使用下列分组入口 |
| `test:unit` | app/server 纯逻辑测试 | 可指定文件和筛选参数 |
| `test:tools` | 工具和产物测试，串行执行 | 可指定文件和筛选参数 |
| `test:component` | Nuxt + happy-dom 挂载回归 | 与纯逻辑测试有不同运行环境 |
| `test:e2e` | 默认应用浏览器场景，CI 拆三个分片 | 不重复执行生产布局与 CSS 专用场景 |
| `test:e2e:legacy` | 最低版本真实浏览器的生产页面验证 | 需已准备对应浏览器与驱动 |
| `test:css:legacy` | 最低版本浏览器的独立工具类验证 | 与应用验收有不同范围 |
| `typecheck` | 应用、scripts、tests 三个 TypeScript 项目 | 单一类型检查入口 |
| `check` | 生成文件检查、lint、typecheck、test | 与 CI unit job 使用相同命令；数据库／浏览器集成仍按专用入口验证 |
| `postinstall` | 安装后的 Nuxt prepare，生成类型及框架中间文件 | 安装钩子，保留；不作为日常手动步骤 |
| `prepare` | 安装 simple-git-hooks | 安装钩子，保留；与 Nuxt prepare 含义不同 |

开发用法见[本地开发](README.md)，配置见[环境分层](../deployment/configuration.md)，发布见[ESA](../deployment/esa-functions.md)，迁移见[迁移工具](../operations/migrations.md)。

CI unit job 直接运行 `pnpm check`。`pnpm typecheck` 依次执行 Nuxt、scripts 和 tests 类型检查，工作流与本地共用同一实现。

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
| [`env/build.ts`](../../scripts/env/build.ts) | 环境模板合成、已有值保留、必填值交互；dev/prod 两个入口共用 | 保留；无需为 dev/prod 复制实现 |
| [`env/gpg.ts`](../../scripts/env/gpg.ts) | encrypt/decrypt/check 共用 GPG、口令和临时文件逻辑 | 保留；3 个动作无需强行变成一个名字 |
| [`env/preload.mjs`](../../scripts/env/preload.mjs) | 在 CLI 业务模块导入前选择并注入 env、移除环境参数 | 保留原生 MJS 预载边界，不能简单改成依赖 Nuxt 的加载器 |
| [`background/worker.ts`](../../scripts/background/worker.ts) | 独立 worker 适配器注册、保活、退出清理 | 保留 |
| [`background/status.ts`](../../scripts/background/status.ts) | 领域账本状态查询及 DB 关闭 | 保留 |
| [`content/preload-check.ts`](../../scripts/content/preload-check.ts) | 预热状态/额度/分层缓存检查及 RAM policy 输出 | 保留，按内容预热归属 content/ |
| [`db/export-sample.ts`](../../scripts/db/export-sample.ts) | mysqldump 流式替换及可选 gzip；db:dump:dev/prod 按来源环境调用 | 保留；显式容器选择；脱敏不等于完整隐私清洗或恢复备份 |
| [`storage/inventory.ts`](../../scripts/storage/inventory.ts)、[`inventory-run.ts`](../../scripts/storage/inventory-run.ts)、[`inventory-catalog.ts`](../../scripts/storage/inventory-catalog.ts)、[`oss-inventory.ts`](../../scripts/storage/oss-inventory.ts) | 专项盘点 CLI、断点与预算、只读归属保护和 GET-only OSS 读取；源码命令及维护产物共用 | 保留；清单不可直接执行删除或 abort |
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

`*.test.ts` 均是测试，不是运维命令。其中 [`verify/package.test.ts`](../../scripts/verify/package.test.ts)、[`deploy/docker-image.test.ts`](../../scripts/deploy/docker-image.test.ts)、[`verify/nuxt-config.test.ts`](../../scripts/verify/nuxt-config.test.ts)、[`migration/maintenance-build.test.ts`](../../scripts/migration/maintenance-build.test.ts) 检查跨文件接线/产物，其余主要跟随相应模块。[`migration/sql.test.ts`](../../scripts/migration/sql.test.ts)、[`catalog-sql.test.ts`](../../scripts/migration/catalog-sql.test.ts)、[`frozen.test.ts`](../../scripts/migration/frozen.test.ts) 分别保护 SQL 执行/失败/幂等、版本识别及历史不可变合同。不要为了减少列表长度删掉这些测试。

迁移实现位于 `migrations/`，scripts/migration 是运行工具。历史迁移与其冻结闭包不得改名、改内容或重新生成摘要来掩盖变化，见[迁移约束](../../.github/instructions/migrations.instructions.md)。

官方 CSS API 的隔离浏览器验证使用 `pnpm exec playwright test --config tests/css.config.ts`，不经过应用服务器和数据库 setup；报告位于 `.dev/css-official-apis/`，验证范围见[评估记录](../reviews/css-official-apis-validation-2026-10-29.md)。它不是 `pnpm test:e2e` 完整应用验收的替代品。

真实生产 CSS 构建验收使用 `pnpm exec playwright test --config tests/css-production.config.ts`，保留 legacy、生产 Browserslist、压缩及分块，创建并清理独立 E2E 数据库。编译配置和资产报告在 `.dev/e2e/<run>/css-build.json`，浏览器报告在 `.dev/css-production/`；详见[生产一致性验收](../reviews/css-production-parity-2026-10-29.md)。

旧浏览器检查提供 `pnpm test:e2e:legacy`（生产构建下的页面与交互）和 `pnpm test:css:legacy`（独立工具类与压缩兼容）两个入口。运行前需要准备历史浏览器和匹配的 WebDriver，前提及范围见[测试手册](testing.md)。

## 建议的整理顺序

### 已完成：CI 与开发检查入口

1. 移除 `generate`、裸 `env:build`、`dev:auth:prepare`、`dev:auth:verify`、`lint:fix` 与 `test:all` 六个入口；对应替代分别是现有 build、显式环境模板、隧道参数、lint 参数，以及明确选择需要的验证范围。
2. 新增 `typecheck` 与 `check`，共 34 个入口。`test:all` 不包含生产 CSS、数据库集成或真实 MQTT，故不继续用该名字表达全量验证。
3. `dev:tunnel` 直接调用 dev/frp.ts，已删除等价薄包装。

### 已完成：修正运维环境命名

运维入口统一为实际来源／操作环境后缀，移除迁移、状态、worker、预热与盘点的无后缀别名；开发重置改为 `content:reset:dev`。底层仍共用一个实现与环境预载，重复追加另一个 `--env` 会被拒绝。旧 S3 `storage:cleanup`、对应脚本和 `cleanup.mjs` 打包入口已随五张旧表退役删除，不再改名保留。完整脚本职责及其保护边界见上表。

### 已完成：按职责收拢 scripts

当前布局：

```text
scripts/
  dev/         # 组合启动、隧道、代理、子进程管理、开发容器入口
  env/         # 模板合成、GPG、预载
  db/          # 开发样本导出
  storage/     # OSS 元数据专项盘点、断点与保护关系核对
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

dev/tunnel.mjs 薄包装已删除。后续可让 migration/maintenance-build.ts 的入口归入构建模块，或将 dev/process.mjs 转 TS 后去掉手写 `.d.mts`；后两项尚未执行。

### 统一规则

- 源码运维命令以“领域:动作:环境”为主，`:dev` / `:prod` 表示实际来源／操作环境，必须固定传给加载器，不能表示产物用途；读写命令使用同一环境命名规则。生产自包含 Node 产物继承容器环境。
- 对同一目标的 plan/check/apply 使用参数区分，别为每一步都再新增 pnpm 名字。迁移已使用 `--dry-run` 和 `--status`，迁移语义保留，不能硬改成与 ESA 完全相同的步骤。
- 同一领域共用实现和配置加载器，不建立新的“大而全脚本 runner”；后台任务 runner 和一次性运维 CLI 是不同生命周期。
- 带写入的运维入口在实际执行前显示环境/目标；查询、预演不得先启动 worker 或执行业务变更。`--help` / policy 只加载必要配置，不依赖无关应用凭据。
- stdout 用于结构化结果或导出内容，stderr 用于进度和脱敏错误；拒绝未知参数。所有工具统一主入口识别与退出清理，避免依赖 Windows 路径字符串形式。
- 样本导出需额外改进：显式选择源库和可选 Docker 容器，不自动优先选固定的 `1Panel-mysql`；输出文件显式指定，补真实入口的跨平台验证。当前正则替换不等于完整隐私脱敏，也不能作为恢复备份。
- 变动入口时同步 package、工作流、Docker/Compose、文档、子进程路径与测试；只检查“文件存在”不足以证明执行接线正确。ESA 新测试已从实际 package recipe 启动隔离夹具。

## 本次核对范围

共享草稿的新增一次性验证入口是 `pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/verify/cloud-drafts.ts --mqtt --capacity`，复用现有迁移工具与随机本地库；没有新增常驻任务或 pnpm 别名。`--mqtt` 启动自己的临时 broker，`--capacity` 记录有界负载；作用域及外部服务替身见[测试手册](testing.md)。

已读取源码及仓库调用关系，未执行数据库导出、清理/重置、迁移或云端发布。仓库外的定时任务、1Panel 手工命令和个人终端历史不在搜索范围；上述“未发现调用方”仅指仓库内部。
