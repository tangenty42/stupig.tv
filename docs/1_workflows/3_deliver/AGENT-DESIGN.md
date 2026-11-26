# AGENT-DESIGN：构建与部署操作补充

- 本文档状态：DONE
- 覆盖范围：部署准入、维护计划、日志与回执、ESA 发布及协调切换
- 上位依据：[SID#1.3.DESIGN](DESIGN.md)
- 实现核对与历史材料：[SID#1.3.AGENT](AGENT.md)

日常发布入口见 DESIGN。首次配置见 [SID#1.0](../0_setup/AGENT-DESIGN.md)；数据库备份、恢复和容器内查询见 [SID#1.4](../4_maintain/AGENT-DESIGN.md)。本节补充发布被拦截或失败时需要核对的内容。

## 普通发布与准入

1. 提交所需 YAML、模板及更新后的 `.env.prod.gpg`，合并到 `main`。Check 通过后自动触发 Deploy；纯文档 main 推送不触发。普通 Deploy 没有手动运行入口。
2. 在 Deploy 中核对 checkout SHA。它只接收本仓库 `main` 的成功 push Check；若当前 main 已有更新的运行时代码，会拒绝这个旧候选，只有文档差异可继续。回到旧行为按 DESIGN 提交回退改动，保留既有迁移。
3. runner 解密 env，检查 ESA 目标后构建应用及 EMQX 镜像。应用 tag 为提交 SHA，EMQX 为 `mqtt-<SHA>`；运行配置的 `APP_IMAGE`／`MQTT_IMAGE` 固定到推送后的 digest，`latest`／`mqtt` 只是兼容别名。
4. 服务器接收候选 env／Compose，拉取镜像并预检完整迁移链。需要维护发布时，旧配置和服务尚未切换，日志会给出计划 ID；可能部分执行的 SQL 会直接要求人工恢复，不能用维护确认绕过。
5. 普通预检通过后切换配置、启动容器，依次检查 broker、应用、公网 HTTP/WSS 和迁移完成回执。全部通过后，runner 才发布同一提交的 ESA 函数。

Deploy 与 Maintenance Deploy 共用串行队列，服务器另有发布锁。不要在它们运行期间手工切换 Compose、镜像或同一 ESA 函数。服务器 Compose 以仓库版本为准，手工改动会被下次发布覆盖。

服务器对每个服务默认最多检查 72 次、间隔 5 秒，可由部署脚本的 `HEALTH_ATTEMPTS`／`HEALTH_INTERVAL_SECONDS` 调整；退出或重启循环会提前失败。检查通过后只用 `docker image prune -f` 清理悬空镜像，共享宿主机不追加 `-a`，以保留其他站点暂未运行的镜像。

这里的健康检查包含容器就绪与公网验收：公网首页、`/api/hooks/healthz`，公开 WSS 的连接及订阅，公开连接拒绝草稿主题，草稿 WSS 拒绝匿名和伪票。它不发送业务消息，也没有覆盖真实登录态草稿编辑、附件读写或页面视觉验收；按本次改动补做对应业务冒烟。

执行依据：[Deploy](../../../.github/workflows/deploy.yml)、[远端部署脚本](../../../scripts/deploy/remote.sh)、[公网验收](../../../scripts/deploy/verify-public.ts)。

## 授权维护计划

1. 从被拦截的 Deploy 日志取得完整的 64 位 `plan_id`，核对提交、待执行迁移、目标库和预计停机影响。计划保存在服务器 `DEPLOY_DIR/.release-plans/<plan_id>/`。
2. 安排维护窗口，先停止独立 worker、外部 cron 等写入者。在 Actions → **Maintenance Deploy** 选择 `main`，填写计划 ID 并勾选 `confirm_maintenance`。
3. 工作流读取计划中的确切提交，先准备并预检 ESA，再复用已经固定的应用和 broker 镜像。服务器核对计划、停止受控应用、再次核对计划，之后才备份并验证恢复、执行维护迁移、验收数据和启动服务。
4. 应用检查通过后发布同一提交的 ESA；核对工作流各阶段及回执，再完成本次维护对应的业务验收。工作流不会替操作者恢复已手动停止的外部任务。

已获授权且具备仓库写权限时，也可用同一入口：

```sh
gh workflow run maintenance-deploy.yml --ref main -f plan_id='<完整计划 ID>' -F confirm_maintenance=true
```

计划绑定候选提交、两个镜像 digest、env／Compose 摘要、原运行版本和配置、数据库身份、完整迁移清单及账本。任一变化导致重新计算的计划不同，就须重新预检并确认新计划；不编辑 `plan.json` 或 `decision.env` 来消除差异。维护工作流不重新构建镜像，也不自动扩大原计划范围。

备份适配器的前提、文件和恢复操作见 [SID#1.4 备份与恢复](../4_maintain/AGENT-DESIGN.md#备份与恢复)。执行依据：[Maintenance Deploy](../../../.github/workflows/maintenance-deploy.yml)、[计划与回执校验](../../../scripts/deploy/release.ts)。

## 失败后先确认停在哪一步

| 停止阶段 | 当前边界与下一步 |
| --- | --- |
| runner 预检、构建或服务器候选预检 | 查看失败步骤；正式服务尚未切换。已推送镜像标签不会因后续失败自动改回 |
| 提示需要维护发布 | 旧服务保持运行；核对计划后走上节，不反复重跑普通 Deploy |
| 提示 SQL 可能部分执行 | 保留现场，按迁移恢复流程核对实际结构和账本；维护确认不跳过此项 |
| 普通发布启动或检查失败 | 仅在数据库仍为原状态、或只完成了预检允许的自动迁移时尝试恢复旧镜像和配置，并检查旧容器。数据库身份、迁移清单、摘要和完成状态都要通过回退核对 |
| 维护备份／恢复验证失败，迁移尚未开始 | 未执行生产迁移；脚本可按原状态恢复此前运行的旧服务。核对日志后处理备份前提 |
| 维护迁移命令已开始，或回退检查不通过 | 停止应用，保留数据库、配置、备份和日志，转人工恢复；即使同为 `cloud-v1` 也不自动启动旧写者 |
| 首次部署没有旧镜像，或自动回退未完整完成 | 根据日志人工恢复，不能把工作流退出当成旧服务已恢复 |
| 应用已通过检查，随后 ESA 发布失败 | 新应用保留；按下节查 ESA 阶段和实际版本，修复后单独发布，不假定应用一起回退 |

首次跨入 `cloud-v1` 后若新进程可能已处理请求，脚本也会阻止旧协议写者自动恢复。镜像或配置回退均不撤销数据库、OSS 对象或外部反代变更。

存量库首次登记新基线时走 Maintenance Deploy。预检会列出登记动作及后续权限迁移。旧镜像的迁移器无法识别新基线回执，因此登记后按维护失败流程处理回退。基线的历史回执要求见[迁移查询与失败恢复](../4_maintain/AGENT-DESIGN.md#迁移查询与失败恢复)。

存量库的旧账本、缺失历史回执或摘要不匹配都会使候选预检在生成计划 ID 前失败。旧账本和缺失回执用定基线前的匹配版本补齐并核对。摘要不匹配按[摘要不一致](../4_maintain/AGENT-DESIGN.md#摘要不一致)核对原文件、账本和部署产物。处理后重跑普通 Deploy 生成计划。

## 日志与回执

先看 Actions 失败步骤和服务器打印的位置，再查看所需文件。计划目录中的 env、数据库备份及原始错误只留在服务器私有目录；分享日志前去掉凭据、完整签名 URL 和业务内容。

| 位置 | 保存什么、用于什么 |
| --- | --- |
| 服务器 `.release-plans/<plan_id>/plan.json` | 固定计划、目标及迁移准入状态；同目录有候选 `.env.prod`、`docker-compose.yml` 和生成的 `decision.env` |
| 同目录 `backup-verification.log`、`maintenance.log`、`data-verification.log` | 维护备份、迁移和启动前数据校验；只在运行到对应阶段时产生 |
| 同目录 `public-verification.log`、`final-migrations.log`、`receipt.log`、`rollback-check.log` | 公网验收、迁移完成、回执保存或失败回退检查 |
| 同目录 `result.json` | 应用就绪回执，含计划、run ID/attempt、迁移指纹及验收范围；在 ESA 发布之前生成 |
| 部署目录 `.deploy-failure-<服务名>.*.log` | 容器就绪失败等路径保留的最后 80 行原始日志；CI 只打印位置 |
| 部署目录 `.env.prod.bak`、`docker-compose.yml.bak` | 上次正式配置的回退副本；后续发布会覆盖，不是长期版本档案 |
| Actions `application-production-receipt` | `.data/releases/*.json`，记录构建提交、应用／broker digest、schema、settings 摘要及协议；单独存在不证明服务器部署成功 |
| Actions `esa-production-receipt` | `.data/esa-deploy/*.json`，记录 ESA 发布阶段、源码摘要及旧／新版本 |
| Actions `maintenance-production-receipt` | 批准计划、本次应用就绪回执和 ESA 记录；仅收取 run ID/attempt 匹配的服务器结果 |

三个 Actions artifact 均保留 30 天。需要长期恢复的材料另行保存，并核验镜像及配置、密文口令仍可取得；artifact 不包含数据库备份。服务器计划目录没有由这两个工作流设置自动保留期。

CI 完整 env 保留 ESA 发布身份，上传服务器前剥离 `ALIYUN_ESA_PUBLISH_*`；运行所需的缓存身份及链接鉴权密钥仍保留。成功发布会尝试清理旧 env 备份中的发布身份，无法安全处理时给出警告；失败回退和其他历史备份可能仍含这些值。按警告检查受控副本，需要撤销旧访问能力时另外轮换凭据。

## 单独发布 ESA

在对应版本的源码仓库根目录执行，准备该环境的 YAML、env 和发布身份。开发需先保证授权回调可达；生产使用准备发布或修复的确切版本。命令后缀选择 dev/prod 配置，两函数的 ESA 槽位目前都叫 `production`。

```sh
pnpm esa:deploy:prod --plan
pnpm esa:deploy:prod --check
pnpm esa:deploy:prod
```

开发将 `:prod` 换成 `:dev`。不用再追加 `--env` 或临时函数名，目标统一改在对应 YAML 的 `esaFunction`；命令不依赖数据库、JWT、短信或 frp 密钥。进程环境优先于 env 文件，排查身份不符时先核对注入来源。

| 模式 | 结果怎么读 |
| --- | --- |
| `--plan` | 只输出本地目标、路由、回调和源码摘要，不联网；密钥可尚未填完 |
| `--check` | 只读核对目标函数、全部启用路由、变量和当前版本；`check: passed` 后仍须查看 `variables` |
| 无参数 | 同步变量 → 创建版本 → 等待 Available → 再核对路由、变量和原活动版本 → 发布该版本到 100% → 读回确认 |

变量的 `missing`、`type-mismatch`、`value-mismatch` 表示需要由正式发布同步的差异；预检会报告它们，但不会因此把 `check` 改为失败。`secret-present-value-unverifiable` 只确认密钥存在且类型正确，无法比较其值。`--check` 也不下载线上代码比对源码摘要。

站点、函数、路由与原生规则必须事先存在。发布只更新当前函数的鉴权密钥、回调、超时和代码，不代建资源、不修改路由或缓存规则；初次配置见 SID#1.0。路由检查覆盖此函数的启用路由，其他函数的重叠范围仍由配置人员核对。

### ESA 失败、锁与业务验收

每次实际发布在 `.data/esa-deploy/` 写记录，失败日志会显示停止阶段与路径。优先核对 `stage`、`failed`、目标、旧版本及本次版本 ID：

- `syncing-variables` 失败可能已经写入部分变量；`creating-version`／`waiting-version` 失败可能已创建未发布版本。先核对记录与云端状态，再决定重试。
- `deploying` 阶段丢失响应时，工具只读回本次版本，不重复写请求；无法确认就失败，不自动回退。先确认实际流量版本，再重试或按兼容方案恢复。
- 本机锁为 `<函数名>-<槽位>.lock`，只防止同一工作区重叠发布。异常退出遗留锁时确认其 PID 已退出再移除；它不协调不同电脑、CI 或控制台，尤其要避免并发改密钥。

控制面读回 100% 后仍可能等待边缘传播。用应用生成的新链接验收合法 GET、HEAD、Range、冷读及缓存命中、中文文件名、跨域图片，以及撤权、无签名、篡改、过期和回调故障时拒绝交付。按变更范围选择测试对象与账号，保存脱敏结果；不把控制面成功当成附件交付验收。

执行依据：[ESA 命令与记录](../../../scripts/esa/cli.ts)、[预检和发布](../../../scripts/esa/deploy.ts)、[配置入口](../../../scripts/esa/config.ts)。

## 协议或鉴权密钥变更

应用与 ESA 依次发布，存在两端版本不同的时间段。不兼容协议升级或鉴权密钥轮换时：

1. 在发布前由操作者启用维护，控制主站与 Content 读取流量，避免继续签发、使用不兼容链接；保留授权回调及部署检查需要的受控通路。
2. 完成同一版本的应用和 ESA 发布，期间保持维护。此类访问维护不会仅因存在或不存在数据库迁移而自动完成；不要停止持久化依赖来代替流量控制。
3. 等待真实请求收敛，验证新链接、缓存命中后撤权和错误签名拒绝。两端及业务验收通过后恢复用户流量；旧页面按需要刷新取得新链接。
4. 任一端失败时保持维护。需要恢复旧版本时，应用、函数和同环境变量必须兼容当前数据库及授权协议，不能单独切回示例函数或只验签不回调的旧函数。

## 前端资源随版本交付

SSR、CSS 和客户端 chunk 随同一应用镜像发布，样式故障也按匹配的镜像整体恢复。发布涉及前端时检查首屏和交互；跨版本旧标签页按下述已接受边界及本次变更需要决定是否验收。容器健康不会发现所有视觉或 chunk 问题。

当前镜像构建不合并上一版 `/_nuxt/` 资源。旧镜像仍存在只说明资源可从该镜像取得，不保证当前线上入口继续提供旧 chunk；主站 HTML／静态资源缓存也不由 Content `/content/` 的 ESA 规则保证。阶段性接受的风险及重新评估条件见 [AGENT](AGENT.md#历史证据与已接受的边界)。
