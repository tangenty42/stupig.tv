# GitHub Actions 与 ACR

> 首次接入与 SSH 主机身份见 [SID#1.0](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#github-仓库与-ssh-主机身份)，发布、维护授权及失败处理见 [SID#1.3.AGENT-DESIGN](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md)，核对记录见 [SID#1.3.AGENT](../../docs/1_workflows/3_deliver/AGENT.md)。本文保留原章节入口和历史发布证据。

事实源：[Check](../../.github/workflows/check.yml)、[Deploy](../../.github/workflows/deploy.yml)、[Maintenance Deploy](../../.github/workflows/maintenance-deploy.yml)、[Dockerfile](../../Dockerfile)、[远端部署脚本](../../scripts/deploy/remote.sh)。

## 仓库设置

Repository Secrets／Variables、Actions 和规则设置，以及 SSH 主机指纹与 known_hosts 示例，见 [SID#1.0 的 GitHub 仓库与 SSH 主机身份](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#github-仓库与-ssh-主机身份)。

### SSH 主机身份

known_hosts 格式已迁入上述初配章节，原发布回执继续保留在下文。

## ACR 准备

创建命名空间与私有镜像仓库，从该实例的访问凭证页面取得实际 registry 和登录名。ACR 新旧个人版地址不同，不能从旧示例猜 registry；按[官方推送/拉取指南](https://help.aliyun.com/zh/acr/user-guide/use-a-container-registry-personal-edition-instance-to-push-and-pull-images)取得地址。企业版也使用实例提供的访问入口和凭据。

首次上线确认 GitHub runner 可登录/推送，服务器可登录/拉取同一仓库；镜像由工作流构建，不由 ACR 自动构建。当前 tag、digest 与部署顺序见 [SID#1.3 的普通发布与准入](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#普通发布与准入)。SSH 失败不会把远端 ACR 标签改回旧版本。

2026-10-25 的 API 历史核对为仓库 PRIVATE/NORMAL、仅一个 latest、无自动构建规则；当时未验证 GitHub 登录凭据或服务器拉取，也未实现固定 tag/digest。2026-10-30 的工作区改动不能替代云端读回；实际资源见[ACR 台账](aliyun.md)。

## 推拉身份

当前按用户决定恢复单套凭据：CI 和生产主机均使用 GitHub `ACR_USERNAME/PASSWORD`，沿用 Tangenty 已有的 ACR Registry 固定密码。用户名从访问凭证页面的 Docker 命令复制；这里不使用阿里云控制台密码或 AccessKey Secret。[官方凭据说明](https://help.aliyun.com/zh/acr/user-guide/configure-access-credentials)。

workflow 在构建前检查两项凭据非空，不再要求独立 pull 身份。服务器获得相同的 Registry 推拉能力。凭据通过 SSH 的加密 stdin 与部署脚本一起传递；base64 只处理 shell 引号，密码通过 Docker `--password-stdin` 输入。

当前 GitHub `SSH_USER` 为 `root`，部署密钥可获得宿主机管理权限；服务器还持有可推送的 ACR 凭据，详见 [RAM 权限边界](ram-reference.md)。改为受限部署身份、拆分 ACR 凭据需要配合服务器和凭据交付方式调整，不能仅靠更改工作流认定已实现最小权限。

目标使用新个人版域名，[官方限制](https://help.aliyun.com/zh/acr/user-guide/individual-edition-instance-independent-domain-name-capacity-limit)仅允许一个 RAM 子账号设置 Registry 密码，因此不再推进双 RAM 方案。已创建的 push/pull 用户及仓库策略保留备用，不参与当前交付；额外控制台初始化策略已撤销并删除。

## CI 到部署的实际顺序

完整操作顺序见 [SID#1.3 的普通发布与准入](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#普通发布与准入)，检查范围见 [SID#1.2 的 CI 汇总](../../docs/1_workflows/2_test/AGENT-DESIGN.md#mqtt-镜像与-ci-汇总)。本节保留工作流的实现约束与旧环境过渡细节。

当前 CI 使用 Node 24、pnpm 12.10.1；迁移 job 在全新 MySQL 8.4 上验证完整 SQL/TS 链及第二遍幂等执行。

Deploy 的本仓库 `push` 事件守卫不可只用分支过滤代替：`workflow_run` 的 `branches` 按触发 run 的 head 分支名匹配，而 fork 的默认分支同样叫 `main`，纯文档 fork PR 的成功 Check 若无事件守卫，就能借默认分支上下文的全部 secrets 与 root SSH 触发部署。安装发布工具时使用锁文件并禁用安装脚本。

运行 env 先通过 SCP 上传到权限为 700 的临时目录，文件权限 600，再原子替换 `.env.prod.incoming`；Compose 另上传为 `docker-compose.yml.incoming`。明文不会打进镜像。

健康等待与镜像清理边界见 [SID#1.3 的普通发布与准入](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#普通发布与准入)。WSS 反代配置仍需单独交付，缺失或接错 listener 会使公网验收失败，见 [MQTT](mqtt.md#wss-反代与应用参数)。

服务器正式文件统一为 `.env.prod`，所有部署 Compose 调用显式使用 `--env-file .env.prod`。首次从旧版 `.env` 升级时，脚本保留旧文件作为回滚来源；新容器健康后才将旧文件移到 `.env.legacy.bak`，失败则恢复旧命名和旧 Compose。

完整生产 env 仍保存在 CI 解密文件与本地加密源中，服务器正式文件只含运行及维护所需变量。首次切换期间旧环境和回滚备份可能仍含发布凭据：成功后脚本尝试从 `.env.prod.bak` 和 `.env.legacy.bak` 删除 `ALIYUN_ESA_PUBLISH_*`；只自动处理可安全识别的单行配置，遇到多行、转义等不支持的格式会保留原文件并在部署日志中警告，需人工检查处理。部署失败回滚时保留原样的旧配置和备份；其他历史备份也不会自动清理。应用原先已经接触过的密钥不会因删除变量而自动失效，如需收回历史访问能力须另外轮换发布凭据。

解密后立即为 env 中按名称识别的密码、密钥和令牌注册 GitHub 日志遮罩，再执行预检和部署；应避免输出任何机密，遮罩不保证覆盖编码或变形后的值，也不保护 artifact。失败日志、回执位置及保留边界见 [SID#1.3 的日志与回执](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#日志与回执)；创建或读取失败日志的错误会在 CI 明确提示。

Docker 构建阶段使用 Node 24、锁文件安装、Nuxt build、maintenance bundle；图片迁移需要的 Sharp 原生运行包也包含在 maintenance 产物中。精简运行镜像与源码命令的区别见 [SID#1.4 的运维工具交付范围](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#运维工具的交付范围)。

## 修改生产环境参数

填写与重新生成的规则见 [SID#1.1 的配置来源](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#配置实际从哪里来)，加密、核对及提交步骤见[生产密文与提交钩子](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#生产密文与提交钩子)。

## 部署失败与回退

按 [SID#1.3 的失败阶段表](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#失败后先确认停在哪一步)确认自动恢复或停写边界；需恢复数据库时转到 [SID#1.4 的误操作后恢复](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#误操作后的恢复)。应用与 ESA 的协调变更见[协议或鉴权密钥变更](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#协议或鉴权密钥变更)。

首次引入 broker 的安全回退路径只移除新增容器并保留卷，不操作旧 1Panel，具体切换见 [MQTT 首次接入](mqtt.md#首次从-1panel-切换)。旧流程没有 SHA tag，不能假定重跑最新 workflow 会选旧代码；重新交付旧提交须核实其实际 checkout SHA、schema 与草稿协议。长期恢复材料的保留边界见[日志与回执](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#日志与回执)。

## 已核对的发布材料（2026-11-01）

本轮从 GitHub 下载当前及上一版的应用／ESA 回执，经 SSH 核对生产主机及 ACR manifest，再通过现有生产发布身份只读核对 ESA。以下关键身份纳入 Git 保存，不再只依赖 30 天 artifact；这是带日期的保留点，不是自动归档或整套回退验收。未切换生产版本、修改云端规则或启动生产业务写入。

镜像仓库统一为 `crpi-kadmhbmp7xfn6991.cn-guangzhou.personal.cr.aliyuncs.com/tangenty42/stupig-tv`，下表 digest 均在此前缀后使用 `@sha256:<摘要>`。两版 app／broker 共 4 个镜像在生产主机可检查，ACR 可返回对应 digest 的 manifest；本轮未重新拉取全部远端镜像层，不承诺云端长期保留策略。

| 保留点 | 源码／Deploy | app digest | broker digest | ESA production 版本 |
| --- | --- | --- | --- | --- |
| 当前 | [3fdc491](https://github.com/tangenty42/stupig.tv/commit/3fdc4912620a4deb5ee58f5a2346e5a78ab6c09d)／[41228238034](https://github.com/tangenty42/stupig.tv/actions/runs/41228238034) | `09260adc432fcada1987f9866772b2df34c6aac12a598eaa884071690d6d84f8` | `9f8e528d5bc4f6b0b234a6cae2969e60ee9b4416880b12513332b05a31e32a4b` | `1793470672060752869` |
| 上一版 | [8980d27](https://github.com/tangenty42/stupig.tv/commit/8980d2771910258b1e2e6452cccf126f7f973ae2)／[41219529204](https://github.com/tangenty42/stupig.tv/actions/runs/41219529204) | `3d3936cd24d8e87e656ce2fab3ead665d4c46230f396657d03facba092238a03` | `8072f970148c0771027b87eb9da45e44c38df2e576a2c863572891ad5e1b5e22` | `1793464220639045157` |

两版回执的 schema 均为 `20261030120000_shared_content_drafts.sql`，协议为 `cloud-v1`，settings SHA-256 均为 `e06d9ed3099eeef689adcbc6ea07595e92f88e055889d847482672801143ac1c`。服务器 `.env.prod` 的发布身份匹配当前版，`.env.prod.bak` 匹配上一版；文件权限均为 600，app／emqx 均 running、healthy。`.bak` 会被后续部署覆盖，不能把它视为多版本配置档案。

### 回执、配置与密钥位置

- 两版 `application-production-receipt`／`esa-production-receipt` 均未过期且实际下载成功。GitHub API 返回的到期时间分别为当前版 **2026-11-30 18:17:57–58 UTC**、上一版 **2026-11-30 16:30:26–27 UTC**。仓库默认 artifact／log 保留为 90 天，但 workflow 显式指定 30 天；不能按默认值推断这四份回执的期限。
- 对应提交保存 Compose、分层 YAML、函数源码、锁文件及 `.env.prod.gpg`。两版生产密文的 Git blob 同为 `e8b8c9b2318ab29edc4fc87d2d1ad0f99599e962`。本机用现有受控口令成功解密，并与本机 `.env.prod` 逐字节比较一致，临时解密副本已删除。本轮未验证口令的独立异地保管。
- 解密口令在 GitHub Repository Secret `ENV_PASSPHRASE`，本机工具也可从进程环境或 `.env.dev` 读取。首次 `pnpm env:check` 因进程继承的不同口令覆盖本机值而报 `Bad session key`；显式使用现有 `.env.dev` 口令后通过，没有重加密或轮换。排查时检查口令来源与优先级，不输出值，不覆盖已验证密文。
- `ACR_USERNAME/PASSWORD`、`SSH_PRIVATE_KEY`、`SSH_KNOWN_HOSTS` 的 GitHub 名称均存在；这里只核对元数据，GitHub 不允许读回 Secret 值。生产主机只接收剥除 ESA 发布凭据的运行配置，本机／CI 完整配置的保管边界见[配置手册](configuration.md)。

### ESA 版本与配置

两版 `stupig-content-auth-bypass-prod` 的上述版本都能通过发布身份取得版本元数据，状态为 Available；当前版本占 production 流量 100%。两份回执中的函数源码 SHA-256 同为 `f8ed3d6e33b542cf0370c37682bbd53dbe6ad153fee255607e6f7718ae51df86`，与各自 Git 提交的 `config/esa/content-auth.mjs` 一致。本轮没有读回线上源码字节。

当前路由通过实际发布预检：SiteId `181553031729356`，完整 `stupig-static.oss.tangenty.cn/content/` 范围，custom、enabled、bypass on、fallback off。普通变量回调 `https://www.stupig.tv/api/content/authorize` 及超时 `5000` 与本机配置匹配；`ALIYUN_ESA_AUTH_KEY` 只能验证 secret_text 存在，无法读回验证值。恢复同环境变量应使用该提交的受控密文，不能只选旧版本号；本轮未导出或重验整个站点的 DNS／缓存／回源／响应头规则。

### 静态资源与旧标签页边界

使用无网络、只读、无生产环境变量的临时容器分别检查两版镜像内的 `/app/.output/public/_nuxt/`，未启动应用，临时容器已自动删除。两版各有 376 个文件，283 个路径共有，上一版独有 93 个文件，其中 92 个为 JS；共有路径中只有可变的 `builds/latest.json` 内容变化。旧 JS 仍在旧镜像内，可随同版本镜像取得，但不在当前镜像中。

公开 HEAD 抽查：当前 `/_nuxt/0ov02JXI.js` 为 200，上一版独有的现代 JS `/_nuxt/2Kr_2MIL.js` 为 404。因此当前交付没有为这份旧资源提供跨版本保留，不能保证部署后旧标签页仍能懒加载旧 chunk。Nuxt 有 chunk 错误／新 manifest 重载机制，但本轮没有验证其与未保存编辑的配合，也没有复现用户可见故障；旧浏览器验证仍暂停。

用户随后确认：当前更新安排在凌晨，宣传尚未铺开，预计几乎没有其他用户长期保持标签页，因此本阶段接受上述风险，暂不补旧资源保留或跨发布旧标签页验证，不作为当前收尾阻塞。这是阶段性取舍，不把尚未验证的重载／编辑保留行为记录为通过；用户规模或使用方式变化、实际出现故障时再评估。

整版本回退仍须核对数据库兼容性；镜像／ESA 版本存在不等于已演练完整切换。后续选择新保留点时更新本节关键身份，继续独立管理镜像、云配置和密钥；本轮未新增自动归档调度或完整恢复平台。

## 授权维护发布

从取得计划 ID、批准窗口到工作流执行，按 [SID#1.3 的授权维护计划](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#授权维护计划)操作。MySQL 适配限制和恢复验证见 [SID#1.4 的维护发布前备份](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#维护发布前备份)，证据保存见[日志与回执](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#日志与回执)。

生产 Compose 的源在仓库，服务器手改会在下一次部署被覆盖。
