# AGENT-DESIGN：开发操作补充

- 本文档状态：DONE
- 覆盖范围：开发进程、授权隧道诊断、配置与密文、迁移编写、提交细节
- 上位文档：[SID#1.1.DESIGN](DESIGN.md)
- 实现基线、迁移来源与未核对范围：[SID#1.1.AGENT](AGENT.md)
- 被权威文档引用：[SID#1.1.DESIGN](DESIGN.md)

日常命令和开发约定以 DESIGN 为准；本文补充操作细节。首次配置见 [SID#1.0](../0_setup/AGENT-DESIGN.md)，测试见 [SID#1.2](../2_test/DESIGN.md)，发布和迁移执行／恢复分别见 [SID#1.3](../3_deliver/DESIGN.md)、[SID#1.4](../4_maintain/DESIGN.md)。

## 开发与配置约定

依赖统一用 pnpm 和现有 lockfile，Node 使用 ESM。先核对宿主机／容器环境和已运行进程，再启动开发服务。日常开发中，只有人类明确要求才运行 `nuxt build`、`nuxt prepare` 或 `nuxt generate`。正常安装生命周期以及测试、CI 中已有的构建按各自流程执行。

公开参数由 `config/app-settings.yaml` 经 `config/lib/schema.ts` 校验，生成 `server/shared/settings.generated.ts`，调用方从 `@shared/settings` 取得。改动后运行 `pnpm settings:generate`，用 `pnpm settings:check` 核对生成结果。部署 YAML、env 模板和 schema 涉及同一配置变更时一并更新。真实凭据保存在本机 env 或运行环境，缺少时向人类确认本地配置，不编造或输出其值。

开发优先复用已有登录态和 DESIGN 中的两个测试账号。执行任何发送验证码的流程前，核对运行中服务的 `NUXT_OTP_DEBUG=true`，否则使用密码或已有会话。保持调试开关以跳过真实短信，禁止给这两个测试号码发送真实验证码。

## 开发进程与端口

### 本机 HTTPS 证书

首次在 Windows 配置时，在仓库根目录运行一次证书安装命令，并确认当前用户的信任提示。随后应用默认在 `https://localhost:3042` 启动。

```powershell
pnpm dev:cert --install
pnpm dev
```

开发证书只在本机生成，不入库：每台机器各自一份 CA 与 `localhost` 身份，避免共用可信任根带来的风险。`--install` 一条命令完成生成、安装与信任：

- 生成：用 OpenSSL（Windows 可用 Git for Windows 自带版本）创建开发 CA（398 天）与 `CN=localhost` 服务证书（397 天，SAN 含 `localhost`、`127.0.0.1`、`::1`）；签发用的 CA 私钥只存在于加密的临时文件，生成后立即删除；
- 落盘：身份保存在当前用户的数据目录 `stupig.tv/https/` 下（Windows 为 `%LOCALAPPDATA%`，其他系统为 `$XDG_DATA_HOME` 或 `~/.local/share`），并为当前检出准备 Git 忽略的 `.dev/https/`；
- 信任：只写当前用户的作用域。Windows 用 `certutil -user -addstore Root`；macOS 用 `security add-trusted-cert -r trustRoot` 写入登录钥匙串；Linux 自动写入 Chromium 的 NSS 库，系统信任库与 Firefox 按命令输出的提示自行导入。

已使用过开发身份的电脑会从用户数据目录复用原证书，同一用户的新检出可直接启动。`pnpm dev` 与 `pnpm dev:app` 启动时都会校验证书链、有效期、主机名与私钥，并为当前检出准备 `.dev/https/`。Nuxt 从文件读取私钥，EMQX 只读挂载 `.dev/https/ca.pem`，授权代理用同一张 CA 校验 `localhost`。

要在另一台机器复用同一身份，把 `ca.pem`、`localhost.pem`、`localhost.key` **三个文件一起**通过受保护渠道放进该检出的 `.dev/https/`。缺少任何一个会直接报错并指出缺了哪些文件，不会与新建身份混用。

证书过期或需要换钥时，先停止开发应用与授权通道，执行 `pnpm dev:cert --rotate`。它把旧证书备份到 `previous-*`、生成并信任新的 CA；若 EMQX 容器正在运行，会自动重建以重新挂载 CA，未运行则跳过，重建失败时打印需要手动执行的命令。轮换完成后启动应用即可。

### 启动开发服务

开始前先检查已有应用和隧道。`pnpm dev` 会启动 Compose 依赖、等待数据库并按 DESIGN 初始化或检查迁移，然后启动授权通道与 Nuxt。依赖和数据库已就绪时，`pnpm dev:app` 只启动 Nuxt。两个命令均在 `https://localhost:3042` 提供应用。端口占用时启动器报错退出。

- 应用和授权代理均绑定 `127.0.0.1`。开发模板的 `APP_PORT=3042` 同时决定 HTTPS 监听端口、站点地址和两个浏览器 WSS 地址。使用其他端口时统一改 `APP_PORT`，并同步开发桶 CORS 中的来源端口。
- 公开通知使用 `wss://localhost:3042/mqtt`，私有草稿使用 `wss://localhost:3042/mqtt-drafts`。开发服务分别转给本机 EMQX 的 `MQTT_WS_PORT`（默认 8083）和 `MQTT_DRAFT_WS_PORT`（默认 8086），两个上游路径均为 `/mqtt`。
- 授权代理在 `devAuthTunnel.proxy.listenPort` 指定的回环端口（默认 55500）接受 frpc 的 HTTP 请求。它用 `.dev/https/ca.pem` 校验 HTTPS 上游的 `localhost` 身份。隧道只复用根路径返回 404 且带 `X-Dev-Auth-Proxy: 2` 的代理。遇到 v1 时先停止旧隧道，再启动新版。其他端口占用仍由操作者核对。
- 已单独启动应用时，用 `pnpm dev:tunnel` 补通道；不要再启动组合入口。只需要依赖时执行下面的 Compose 命令。
- 开发 MySQL、Redis、EMQX 和 phpMyAdmin 的宿主机端口均限定回环。改端口绑定后重建对应容器，保留数据卷；普通启动错误不要靠删卷处理。

```powershell
docker compose --env-file .env.dev -f docker-compose.dev.yml up -d
docker compose --env-file .env.dev -f docker-compose.dev.yml ps
```

安装依赖时已有的 `postinstall` 会运行 Nuxt prepare，`prepare` 安装 Git hooks。日常 HMR 不需要反复运行 prepare、build、generate 或维护产物打包；需要构建产物时按交付或测试流程执行。

数据库准备由[子进程启动器](../../../scripts/dev/database.ts)调用，`--import` 通过 `file:` URL 加载环境预加载模块，兼容 Windows 盘符路径。

实现入口：[组合启动器](../../../scripts/dev/cli.ts)、[数据库准备](../../../scripts/migration/dev-bootstrap.ts)、[开发 Compose](../../../docker-compose.dev.yml)。

## 授权隧道与 ESA 提示

开发通道依次经过 ESA 回调域名 → frps 代理端口 → 本机授权代理 → Nuxt 的 `POST /api/hooks/esa/authorize`。frpc 的 WSS 连接域名和 ESA 回调域名用途不同；回调地址从 `esaFunction.callbackUrl` 读取，必须带完整授权路径。

本机 frpc 版本及路径按 [初次配置](../0_setup/AGENT-DESIGN.md#6-连上开发回调并启动)准备，路径覆盖放 `config/local.yaml`，token 放 `.env.dev` 的 `DEV_FRP_TOKEN`。

| 命令／现象 | 实际作用与下一步 |
| --- | --- |
| `pnpm dev:tunnel --prepare` | 生成 `.dev/auth/frpc.json` 和公共 CA bundle；token 通过子进程环境中的 JSON 模板注入，不写进生成 JSON |
| `pnpm dev:tunnel --verify` | 先准备配置，再检查 frpc 版本并运行原生配置校验；此时尚未连接服务器 |
| `pnpm dev:tunnel` | 运行代理和 frpc，意外退出后重试，并周期性探测公网回调；不会修改 DNS、服务器反代或发布 ESA |
| 端口被未知进程占用 | 核对该端口的进程身份与启动终端；保留仍在使用的实例，处理冲突后重试 |
| `callback unavailable`／异常状态码 | 顺序检查本机应用、代理、frpc 注册、服务器反代和公网回调；不要将 frpc 控制域名填成回调域名 |
| `callback reachable` | 空 JSON 授权 POST 得到预期 403 且带开发代理标记；还需真实读取 grant 的授权与下载验收 |

根路径返回 404 是预期拒绝。真实链路验收检查合法 GET／HEAD／Range、完整下载摘要，以及缓存 HIT 后撤权、回调不可达时拒绝。grant、签名 URL、token 和授权请求正文不进入共享日志。服务器 frps／反代配置见[初次配置的 FRP 示例](../0_setup/AGENT-DESIGN.md#frp-服务端配置)。

`pnpm dev` 另起子进程只读检查开发 ESA 的活动版本、路由及非机密变量，不阻塞 Nuxt。优先比较源码摘要；旧版本缺少摘要时尝试在线源码，或对应同一目标和活动版本的本机发布记录；证据不足会提示无法核对。权限或网络异常先用 `pnpm esa:deploy:dev --check` 排查，需要更新时才执行 `pnpm esa:deploy:dev`。只读检查无法比较加密密钥，仍以真实附件读取验收为准。

实现入口：[隧道启动器](../../../scripts/dev/frp.ts)、[通道配置](../../../scripts/dev/auth-config.ts)、[ESA 提示](../../../scripts/dev/esa-notice.ts)。

## 配置实际从哪里来

| 配置层 | 合并或选择方式 |
| --- | --- |
| 部署 YAML | `shared.yaml` → `dev.yaml` 或 `prod.yaml`；开发最后追加可选 `local.yaml`，生产不读取它 |
| YAML 中的值 | 映射递归合并，数组、标量和 `null` 整体覆盖；可空子树设为 `null` 后不再要求其凭据，但对应功能会不可用 |
| YAML 插值 | 仅替换显式 `${VAR}`；缺失时报错。`${VAR:-fallback}` 在缺失或空值时使用默认值；env 不会任意覆盖同名 YAML 字段 |
| 运行环境 | `development` 对应 `.env.dev`，`production` 对应 `.env.prod`；不读取旧 `.env`，也不跨环境兜底 |
| 源码运维命令 | `:dev`／`:prod` 在导入业务模块前固定环境，覆盖继承的 `NODE_ENV`；不要重复追加 `--env` |
| 同名变量 | 进程已注入的值优先于 env 文件；文件中的 `NODE_ENV` 若存在，必须与选定环境一致 |
| Compose | 手工执行时显式带 `--env-file`；服务的 `env_file` 不会替 Compose 选择用于插值的文件 |

改了 env 仍连接旧目标时，先查终端是否遗留同名变量。配置加载器缓存进程快照，改运行配置后重启应用／worker。环境模板重建保留旧值，具体行为见 DESIGN；改模板默认值不会替换已有凭据。

公开业务参数走 `app-settings.yaml` → 生成模块；仅验证过的公开子集进入浏览器。数据库工具只验证所需 DB 子树，迁移按需读取 OSS／图片配置；不要为它们添加无关的 JWT、短信等必填要求。

实现入口：[环境选择器](../../../config/lib/environment.mjs)、[配置加载器](../../../config/lib/loader.ts)、[环境生成器](../../../scripts/env/build.ts)。连接、凭据和云服务字段见[初配字段](../0_setup/AGENT-DESIGN.md#初配字段与反代示例)，领域时序与容量默认值见各领域 AGENT-DESIGN 的配置说明（如 [SID#2.5『配置』](../../2_domains/5_operations/AGENT-DESIGN.md#配置)、`SID#2.4.7`『各后台任务』），以当前 schema／YAML 为准。

## 生产密文与提交钩子

`pnpm env:encrypt` 更新 `.env.prod.gpg`；`pnpm env:decrypt` 会覆盖本机 `.env.prod`，执行前保留需要的本机改动。`pnpm env:check` 解密到临时文件，与本机明文逐字节比较并清理临时文件；格式或换行差异也需要重新加密。它检查明密文是否同步，配置有效性仍由对应工具校验。

口令优先取进程的 `ENV_PASSPHRASE`，其次取 `.env.dev`；都没有时交给 GPG 交互输入。Windows 优先使用 Git for Windows 的真实 `gpg.exe`，以避免 shim 在管道模式下挂起。批处理通过 stdin 传口令，不接受换行或 NUL；加密固定使用 AES-256、SHA-256 和迭代加盐 S2K。

更换口令时，先确认本机实际取值来源，重新加密并运行 `env:check`，再协调 GitHub Secret 与密文交付。旧密文仍在 Git 历史里；若旧口令泄露，应同时处理其中生产凭据的轮换。

pre-commit 只处理匹配的暂存文件；`.env.prod.gpg` 暂存时才触发 `env:check`。ESLint 自动修复后检查暂存 diff，测试选择见 SID#1.2。实现见 [GPG 工具](../../../scripts/env/gpg.ts)和 [package.json](../../../package.json)。

## 编写数据库迁移

### 新版本与在线声明

1. 在 `migrations/` 追加时间戳入口，排在所有已完成或已开始版本之后；SQL、TS 按完整文件名共用一条版本链。表名用 snake_case，时间用 UTC，布尔列用 `tinyint(1)`。
2. SQL 和 TS 默认按维护迁移处理。只有审核确认与正在运行的旧应用兼容，才声明普通迁移：SQL 在 [deployment.json](../../../migrations/deployment.json) 的 `automatic_sql` 中登记完整文件名及精确 SHA-256；TS 在 `define_migration` 中显式设置 `execution: 'automatic'`。声明与迁移同一提交审核。
3. 在 [frozen.test.ts](../../../scripts/migration/frozen.test.ts) 登记 SQL 文件摘要或完整 TS bundle 摘要。TS 入口排在当前基线之后，使用 [define_migration](../../../scripts/migration/contract.ts)。当前 `frozen_scripts` 为空，新增时逐条登记。
4. 按 SID#1.2 验证新库重放、中断续跑与冻结产物；仅空库成功不能证明历史版本没被改。迁移执行、部署准入及失败恢复按 SID#1.4。

SQL 在线声明的摘要必须匹配实际文件。`migration_runs` 是当前账本，完成回执要求 `status=completed` 且 `finished_at` 非空。[基线清单](../../../scripts/migration/baseline.ts)保留已退役版本的原摘要，执行器继续校验存量库里的这些回执。

### TS 的操作边界

- 模块导入无副作用；`plan`、`verify` 只查询，输出安全计数、问题码及摘要。`verify` 必须明确返回 `true`。正文、密钥、签名 URL 和检查点内容不输出到日志。
- 只读上下文在只读事务中只接受单条 SELECT／SHOW／EXPLAIN；这不是对任意 Node 或 SDK 调用的沙箱，脚本仍需遵守只读约定。
- `apply` 分有界批次，业务写入和对应 `ctx.checkpoint.save()` 放在同一个 `ctx.transaction()` 内原子提交。事务不可嵌套，不手动管理事务，也不在其中执行 DDL 或远程 OSS 操作。
- 检查点为有限 JSON，最多 64 KiB；逐对象版本、摘要和分片身份放领域迁移明细表。新表必须同时写退出方案，见下文。
- `ctx.oss()` 的 SDK 操作会复核执行权；其他客户端需要自己调用 `ctx.assert_active()`、检查 signal，并在批次边界响应停止。已发出的远程请求仍可能成功，应凭不可变 key、持久回执和读回核对处理未知结果，不能盲目重放。
- apply 成功后先保存 verify 阶段；此后失败重跑会重新 plan／verify，不再执行 apply。设计验证时不要依赖 apply 再执行一次来修补结果。

### TS 迁移生命周期管理

TS 迁移是临时的数据转换工具。生产执行成功后，应在适当时机定新基线、删除已执行的 TS 迁移：

1. 用前一发布版本迁移隔离库，核对最终结构和空库所需的初始数据。基线须包含退役脚本的结构变更。当前基线由历史 SQL 与 WebP、旧表退役的结构变更组成。
2. 更新 [基线清单](../../../scripts/migration/baseline.ts)的基线文件名、精确覆盖的 SQL 及其原摘要，并在 [冻结测试](../../../scripts/migration/frozen.test.ts)登记基线摘要。保留被覆盖的 SQL 文件和原字节。
3. 保留待交付的数据变更为基线之后独立执行的迁移。验证空库结构、前一版本带数据的升级路径和中断续跑。
4. 将已完成并退役的入口及其冻结摘要登记到基线清单，再移除相应 TS、快照和专项入口。留存可执行旧迁移的发布版本。`frozen_scripts` 继续登记当前目录实际保留的 TS。

当前执行器在空库执行基线 SQL，再于同一事务写入基线完成回执和覆盖的 SQL 回执。存量库须先用定基线前的发布版本完成历史迁移，当前版本核对回执后在维护窗口只登记基线，再执行后续待办。只有旧账本、缺少回执或仍有未完成迁移的库，先按旧版本恢复流程处理。

**触发条件**：TS 迁移执行完、累积迁移过多（建议 >20 个）、大版本发布前、依赖大重构时。

**不保留历史 TS 迁移的原因**：它们会随依赖演进而"腐烂"（打包时包含完整依赖闭包），重跑成本高，且生产执行完后不再需要。定新基线后，新环境只需执行一个基线 + 后续新迁移，避免依赖冲突。

现行结构以基线 SQL 及后续迁移为准。SQL 和 TS 共用文件名顺序。已执行 SQL、已开始 TS 及其依赖实现均冻结，包括历史 SQL 中关于已删除结构 dump 的注释。另加新版本表达调整，保留原冻结摘要。冻结测试按 LF 规范形式计算 SQL 摘要，执行器按实际文件内容核对历史清单和数据库回执。

### 迁移明细表

迁移目录有 TS 入口时，源码命令先构建冻结产物。dev 写入 `.nuxt/migration-scripts/`，prod 写入 `.nuxt/migration-runtime/` 并打包原生依赖清单。当前目录只有 SQL，源码入口跳过构建。生产镜像使用预构建入口，差异见 SID#1.4。

新增迁移专用表时，在同一 PR 写清用途、使用者、保留起点／期限、归档证据、未完成责任和删除条件。小量进度优先用现有 checkpoint；`migration_runs` 以及仍供运行时使用的账本不当作临时表。归档与退出要经过验收、保留、读回核验、责任交接，再以独立维护迁移退役；期限到达不自动删表。归档和恢复步骤以及现存各表的具体退出条件见[维护补充](../4_maintain/AGENT-DESIGN.md#迁移明细归档与退役)。

## PR 与合并后的补充

提交与分支格式以 DESIGN 为准。description 除专名和缩写外用小写；PR 正文用英文，按[模板](../../../.github/pull_request_template.md)依次写 Background、Changes、Impact、Verification、Evidence & References，无内容的栏目写 `None`。

Verification 写实际运行的检查及结果。Evidence & References 放支持问题或决策的脱敏日志、截图、录像、复现、测量、关联 issue／PR 或外部来源。避免放入凭据、完整签名 URL 和无关个人信息。文档变更写 Changes，证据与验证结果各写一次。

普通分支的提交和 PR 标题统一用 `type(scope): description`，一行英文祈使句，末尾无句号。scope 必填，只用小写字母、数字和连字符，description 除专名和缩写外小写，type 取值见 DESIGN。普通提交只保留标题，无正文、列表、理由或 trailer。分支从更新后的 main 开始，沿用 DESIGN 的命名。PR 标题与各提交标题可以不同。

main 只做 squash 合并。合并消息用 PR 标题加 ` (#<PR id>)`。只有一个提交时只保留该标题。多个提交时按 GitHub 的顺序在下面用 `* <commit title>` 列出，标题与列表之间、每个列表项之间均空一行，使用实际换行和无 BOM 的 UTF-8。会话中明确要求的例外优先。

Squash 后 `git branch -d` 可能因提交图不同而拒绝删除，只有确认 PR 已合并且分支没有额外工作，才使用 `git branch -D`。不批量删除旧分支，不手动删除已由 GitHub 自动清理的远端分支，也不复用已合并分支。

确认合并后，在工作区允许时切回 main 并执行 `git pull --ff-only`，再清理已核对的本地分支。
