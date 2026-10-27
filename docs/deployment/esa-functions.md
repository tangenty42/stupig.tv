# ESA Content 边缘函数与发布

应用和函数共用 YAML / env 环境链。发布入口是 `pnpm esa:deploy:dev` / `pnpm esa:deploy:prod`，实现位于 [`scripts/esa/`](../../scripts/esa/)。命令自动同步变量、创建版本、发布该版本并核验；不再手动串联 env/secret/commit/deploy。

## 唯一配置入口

配置按 [shared.yaml](../../config/shared.yaml) → [dev.yaml](../../config/dev.yaml) / [prod.yaml](../../config/prod.yaml) 合并，开发可再由 `local.yaml` 覆盖。栏目统一为 `esaFunction`：

| 字段 | 职责 |
| --- | --- |
| `name` | 环境层指定已存在的函数名；开发 `stupig-content-auth-bypass-dev`，生产 `stupig-content-auth-bypass-prod` |
| `callbackUrl` | 完整 HTTPS `/api/content/authorize` 地址；开发隧道校验也读取此处 |
| `entry` | 相对仓库的入口，默认 `config/esa/content-auth.mjs` |
| `environment` | ESA 发布槽位，当前两个函数均为 `production` |
| `siteId` | 从对应 env 的 `ALIYUN_ESA_SITE_ID` 读取，与缓存维护共用站点标识 |
| `accessKeyId` / `accessKeySecret` | 从对应 env 的 `ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID/SECRET` 读取 |
| `regionId` / `endpoint` | 当前发布工具固定使用杭州 ESA 管理 API |
| `timeoutMs` | 单次 API 超时，默认 15000 ms |
| `readinessTimeoutMs` | 创建版本、等待就绪与等待部署读回的时间预算，默认 300000 ms |
| `authTimeoutMs` | 函数授权回调超时，默认 5000 ms，范围 1–15000 |

Content 域名和签名密钥直接复用同环境的 `aliyun.esa.baseUrl` / `aliyun.esa.authKey`，不重复配置。生产默认回调为 `https://www.stupig.tv/api/content/authorize`；若使用独立授权域名，只修改 prod YAML 的 `esaFunction.callbackUrl`。

两个命令内部固定传入 `--env=dev` / `--env=prod`，同时选择对应 YAML 和 env 文件；无需手动加环境参数，也不要再追加另一个 `--env`。dev/prod 不是 ESA 的槽位名称，必须有不同函数名及 Content 域名。工具拒绝临时 `--name` 覆盖；改名只改相应 YAML 的 `name`。根目录旧 `esa.jsonc`、旧 `pnpm esa` 和无环境后缀的 `pnpm esa:deploy` 入口已移除。

发布配置不会进入应用运行配置或浏览器，也不要求数据库、JWT、短信或 frp 密钥。进程环境优先于选中 env 文件，规则与其他 CLI 一致；子进程显式使用选中的发布身份，忽略外部遗留的 `ESA_ACCESS_KEY_*`。真实凭据仅放本机 env 或 CI 注入，不放 YAML。

## 命令

在仓库根目录执行：

```sh
# 只显示配置和源码摘要，不联网，不要求密钥已填完
pnpm esa:deploy:dev --plan
pnpm esa:deploy:prod --plan

# 只读检查函数、路由、现有变量和发布版本；不会同步或发布
pnpm esa:deploy:dev --check
pnpm esa:deploy:prod --check

# 一次完成变量同步、代码版本创建、发布、读回
pnpm esa:deploy:dev
pnpm esa:deploy:prod
```

日常开发先启动 `pnpm dev`，确保公网回调可用，再运行开发发布命令。`pnpm dev`、`pnpm env:build` 均不会自动发布函数。`--check` 会列出变量缺失或差异，这些差异由正式发布修正；加密变量只能核验类型/存在性，不能读回其明文值。

`pnpm dev` 另外在后台运行不阻塞启动的只读提示。新发布的开发版本在描述中保存规范化源码的 128 位截断 SHA-256 摘要和运行标识，供启动时与本地源码比较；旧版本没有摘要时尝试读取在线源码，或使用本机与当前活动版本及目标精确匹配的成功发布记录。都不可用时报告无法核对。该提示还检查路由和非机密变量，但不会比对加密密钥，也不证明附件交付成功。生产版本描述和发布流程保持原有规则。

2026-10-25 开发和生产均已通过本命令正式发布当前入口，生产版本为 `1792910878247505140`，已通过真实下载与授权回调验收，见[源码和版本核对](aliyun.md)。`--check` 不下载在线代码做源码摘要比较，因此检查通过不能代替正式发布与业务验收。

生产日常交付由 [Deploy 工作流](../../.github/workflows/deploy.yml) 自动调用同一命令：解密 `.env.prod.gpg` → 只读 ESA 预检 → 推送镜像 → 部署应用并通过健康门 → 发布生产函数。只有首次资源准备、配置变更及失败处理需要人工操作。单独修复函数时仍可从本机执行生产命令。

修改生产凭据后执行 `pnpm env:encrypt` 和 `pnpm env:check`，提交 `.env.prod.gpg`；否则 CI 使用的仍是旧凭据。YAML 变更随代码交付，不需要为函数名再次生成 env。

## 首次准备与路由

工具要求目标函数和路由已存在；不会代建站点、DNS、函数、RAM 策略或修改路由、缓存、回源、响应头。发布身份采用 [RAM 发布策略](ram.md)，不授予 CreateRoutine 或 UpdateRoutineRoute；生产使用独立发布身份。完整原生交付配置见 [ESA 规则](esa.md)。

`--plan` 输出当前环境的路由表达式及安全开关。自定义路由使用完整 Content 范围，例如开发：

```text
(http.host eq "stupig-static-dev.oss.tangenty.cn" and starts_with(http.request.uri, "/content/"))
```

也接受等价的 `http.host` 与 `starts_with(http.request.full_uri, "https://对应域名/content/")` 组合。由于当前旁路 URI 路径问题，工具不接受 `.uri.path` 写法；不要附加 auth_key 或 GET 条件，无签名请求和 HEAD 也必须进入授权入口。复杂等价表达式需先调整为工具支持的规范写法。

| 路由字段 | 必须值 |
| --- | --- |
| `SiteId` / `RoutineName` | 对应 YAML/env 目标 |
| `Mode` | `custom` |
| `RouteEnable` | `on` |
| `Bypass` | `on` |
| `Fallback` | `off` |

预检分页核对这个函数的全部启用路由；不匹配时在写变量前停止。它不扫描整个账号所有其他函数，管理员仍需排除更宽的重叠路由、其他域名绑定或绕过授权的设置。字段含义见 [ListRoutineRoutes](https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-listroutineroutes) 和[域名与路由](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/trigger)。

## 自动发布的步骤与记录

1. 验证环境配置、凭据格式，读取入口快照并计算 SHA-256；使用本机目标锁避免本机重叠发布。
2. 读取函数、路由和当前部署版本，记录旧版本。
3. 在所选 ESA 槽位同步 `ALIYUN_ESA_AUTH_KEY`（`secret_text`）、`CONTENT_AUTH_URL` 和 `CONTENT_AUTH_TIMEOUT_MS`（`plain_text`）。密钥经 HTTPS API 请求正文提交，不放命令参数或日志；不删除其他变量。
4. 用锁定的 `esa-cli@1.0.13` 上传入口快照，明确 `--no-bundle`，保留 `import('alibaba:workers')`。临时项目只包含入口和生成的 CLI 配置，不打包 env、Nuxt 或静态资源。
5. 只接受本次 commit 返回的唯一版本 ID；包括 Init 在内的构建中状态持续等待，直到 Available。分页枚举版本并核对精确 ID、描述及绑定环境，不依赖描述搜索。描述使用紧凑的环境名与运行 UUID；完整时间与源码摘要保存在本地收据。
6. 再次检查路由、普通变量与当前部署未漂移，部署新版本到 100%；读回相同版本和流量比例后才报告成功。

变量变更不会直接影响运行版本，必须生成并发布新版本，见[阿里云函数变量说明](https://help.aliyun.com/zh/edge-security-acceleration/esa/user-guide/function-variable)。CLI 参数依据[官方命令文档](https://github.com/aliyun/alibabacloud-esa-cli/blob/master/docs/Commands_en.md)，实际适配以仓库锁定版本为准。

每次实际发布在忽略目录 `.data/esa-deploy/` 写 JSON 记录，含目标、源码摘要、阶段、旧/新版本，不含密钥。CI 以 `esa-production-receipt` artifact 保留 30 天。失败时日志显示停止阶段和记录路径；SDK/CLI 原始异常可能含凭据，因此不直接输出。

写操作不自动重试。部署请求响应丢失时只读回本次目标版本进行确认；无法确认则失败，不重复切换或自动回退。变量同步或 commit 失败时可能已有部分变量或未发布版本，先检查记录和控制台再重试。本机进程异常退出遗留 `.lock` 时，确认对应 PID 已退出后再移除该目标锁。锁不跨机器，发布期间勿同时从本机、CI、控制台操作同一函数；尤其不能并发轮换加密变量，API 无法读回比较其值。

## 在线授权与验收

部署入口默认导出 `async bypass`。先校验签名，再 fetch 固定 HTTPS 回调，只有 204 加正确 `X-Content-Authorization` HMAC 证明才以 `ResponseBypass` 交给 ESA 原生交付；函数不代理大文件字节。403、超时、错误证明、重定向、配置缺失均失败关闭，没有成功授权缓存。具体权限语义见[读取授权](../modules/content/access.md)。

回调允许 POST JSON 与证明响应头，不缓存、不重定向登录、不加浏览器挑战。回调可达是缓存 HIT 读取的必要条件。入口 `TTL_SECONDS=300` 必须与应用 `aliyun.esa.urlTtlSeconds` 一致，允许最多 30 秒未来签名时钟偏差；边缘缓存 TTL 与此无关。

命令成功证明控制面版本和目标匹配，不代表合法下载已验收。实际观察到控制面确认后仍有边缘传播延迟；切换或恢复后先等待真实请求行为收敛，再判断业务结果。按 [ESA 验收矩阵](esa.md)检查允许/拒绝、缓存 HIT、HEAD、Range、完整下载摘要、中文文件名及 Canvas；记录脱敏结果，不记录完整签名 URL。开发隧道换域名后还需验证实际授权证明，根路径 Not Found 不代表协议通过。

应用和 ESA 是顺序发布，不是原子事务。应用健康后若 ESA 发布失败，应用会保持新版本；工具不会替你回滚数据库或应用。读取密钥轮换与不兼容协议变更要安排协调切换，不能承诺无停机。回退只能选择与当前应用协议及同环境变量快照兼容的版本，不能退回仅验签、不回调的旧实现。恢复步骤见[部署与回退](github-acr.md)。

## 签名升级的维护切换

当前 URL 协议为 v2 HMAC-SHA256，旧 MD5/Type A 链接即使未过期也拒绝，没有兼容窗口。协议内容见[读取授权](../modules/content/access.md)。此类不兼容升级必须按维护窗口执行，不能把应用健康视为允许恢复用户访问：

1. 在触发发布前开启维护，阻止主站继续签发或使用旧链接，并保持 Content 读取入口受控；不要停止数据库、Redis、MQTT 等共享或持久化依赖来代替访问维护。
2. 完成同一版本的应用和 ESA 发布。现有工作流先部署应用、通过健康门，再发布边缘函数；两步之间必须保持维护。不要额外叠加以原生 Type A 校验 `auth_key` 的规则，私有 OSS 回源授权仍须保留。
3. 等待边缘传播后，从新应用取得新链接，验证 GET、HEAD、Range、中文下载文件名、缓存 HIT 后撤权、回调故障拒绝，以及旧 MD5、无签名、篡改和过期链接拒绝。此检查也覆盖真实节点的 Crypto/Buffer API 兼容性；本地 Node 测试不替代云端验收。
4. 两端及在线授权验收均通过后再关闭维护，旧页面需刷新以取得新签名。不因旧链接失败临时放宽验签或关闭在线回调。

任一发布或验收失败时继续维护。若必须回退，应用、函数和对应环境变量必须恢复为同一套兼容版本并重新验收；只回退其中一端可能使所有读取失败。该流程不自动停服，也不自动恢复流量，维护由发布操作者控制。
