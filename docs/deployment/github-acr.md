# GitHub Actions 与 ACR

事实源：[Check](../../.github/workflows/check.yml)、[Deploy](../../.github/workflows/deploy.yml)、[Dockerfile](../../Dockerfile)、[远端部署脚本](../../scripts/deploy/remote.sh)。

## 仓库设置

在 GitHub 仓库 Settings → Secrets and variables → Actions 配置下表。当前 workflow 未声明 GitHub Environment，因此应配置 Repository Secrets/Variables，不能只放在尚未被 job 引用的 Environment 中。入口和权限说明见 [GitHub 官方文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | `ACR_IMAGE` | 完整 `registry/namespace/repository`，不带 tag；与生产 env 中同名项一致 |
| Variable | `SSH_HOST`、`SSH_PORT`、`SSH_USER` | 可从 GitHub runner 访问的服务器及部署账号 |
| Variable | `DEPLOY_DIR` | 服务器上已经创建、部署账号可写的绝对目录 |
| Secret | `ACR_USERNAME`、`ACR_PASSWORD` | CI 推送与服务器拉取共用的 Registry 登录凭据；当前沿用 Tangenty 的 ACR 固定密码 |
| Secret | `SSH_PRIVATE_KEY` | 部署账号对应私钥 |
| Secret | `ENV_PASSPHRASE` | 解密已提交 `.env.prod.gpg` 的口令 |

GitHub Ruleset 应要求 `check` 与 `migrations` 检查通过。仓库中的注释记录曾配置过规则，但本轮未在线读取 Ruleset，应在仓库控制台确认当前要求。

## ACR 准备

创建命名空间与私有镜像仓库，从该实例的访问凭证页面取得实际 registry 和登录名。ACR 新旧个人版地址不同，不能从旧示例猜 registry；按[官方推送/拉取指南](https://help.aliyun.com/zh/acr/user-guide/use-a-container-registry-personal-edition-instance-to-push-and-pull-images)取得地址。企业版也使用实例提供的访问入口和凭据。

首次上线确认 GitHub runner 可登录/推送，服务器可登录/拉取同一仓库。当前流程维护应用 `:latest` 和 EMQX `:mqtt`，没有每次 SHA tag，也不由 ACR 自动构建。构建成功后推送；后续 SSH 部署失败只恢复服务器本地镜像标签，不会把远端 ACR 标签改回旧版本。

2026-10-25 已通过个人版 API 重新确认目标仓库 PRIVATE/NORMAL、仅一个 latest、无自动构建规则；未验证 GitHub 中的登录凭据和服务器拉取。推拉共用一组 Registry 凭据，固定发布 tag/digest 尚未实现；实际资源与云端状态见[ACR 台账](aliyun.md)。

## 推拉身份

当前按用户决定恢复单套凭据：CI 和生产主机均使用 GitHub `ACR_USERNAME/PASSWORD`，沿用 Tangenty 已有的 ACR Registry 固定密码。用户名从访问凭证页面的 Docker 命令复制；这里不使用阿里云控制台密码或 AccessKey Secret。[官方凭据说明](https://help.aliyun.com/zh/acr/user-guide/configure-access-credentials)。

workflow 在构建前检查两项凭据非空，不再要求独立 pull 身份。服务器获得相同的 Registry 推拉能力。凭据通过 SSH 的加密 stdin 与部署脚本一起传递；base64 只处理 shell 引号，密码通过 Docker `--password-stdin` 输入。本轮没有改动固定密码、GitHub Secrets 或触发实际部署。

目标使用新个人版域名，[官方限制](https://help.aliyun.com/zh/acr/user-guide/individual-edition-instance-independent-domain-name-capacity-limit)仅允许一个 RAM 子账号设置 Registry 密码，因此不再推进双 RAM 方案。已创建的 push/pull 用户及仓库策略保留备用，不参与当前交付；额外控制台初始化策略已撤销并删除。

## CI 到部署的实际顺序

1. Pull Request 和非纯文档的 main push 触发 Check。Node 24、pnpm 12.10.1，运行 settings 一致性、lint、Nuxt typecheck、脚本 typecheck、Vitest；纯文档 PR 跳过应用检查，纯文档 main push 不触发 Check 或 Deploy。
2. 独立 Check jobs 验证真实生产 MQTT 镜像的权限与重启持久化、Chromium 浏览器流程，以及全新 MySQL 8.4 的完整 SQL/TS 迁移、第二遍幂等执行、隔离迁移框架和 Content 转换。CI 的存储边界夹具不代表真实生产 OSS/ESA 已验收。
3. main 的 Check 成功触发 Deploy，检出该次 Check 的 `head_sha`；部署同组串行，不取消正在执行的旧部署。安装发布工具时使用锁文件并禁用安装脚本。
4. runner 用 GPG 解密 `.env.prod.gpg`，先运行 `pnpm esa:deploy:prod --check` 核对函数、路由和凭据；通过后构建/推送 ACR latest 与 mqtt，并上传 `.env.prod.incoming` 及 `docker-compose.yml.incoming`。明文不会打进镜像。
5. SSH 将 `scripts/deploy/remote.sh` 交给远端 shell，备份旧 env/Compose 和旧运行镜像 ID，校验候选配置，再 pull/up。
6. 应用依赖 EMQX 凭据健康检查；远端另对两个服务依次执行健康门，默认各最多 72 次、间隔 5 秒。容器退出或重启循环立即失败；两个服务健康后只清理悬空镜像。WSS 反代切换仍需手动完成，见 [MQTT](mqtt.md)。
7. 健康门成功后运行 `pnpm esa:deploy:prod`，同步函数变量、创建并发布本次代码版本，读回确认。目标统一来自 prod YAML 的 `esaFunction`，无需在工作流中重复函数名或回调。
8. 无论成功或失败，清理 runner 明文 `.env.prod`，上传不含密钥的 `esa-production-receipt` artifact，保留 30 天。发布详情与首次资源准备见[函数发布](esa-functions.md)。

服务器正式文件统一为 `.env.prod`，所有部署 Compose 调用显式使用 `--env-file .env.prod`。首次从旧版 `.env` 升级时，脚本保留旧文件作为回滚来源；新容器健康后才将旧文件移到 `.env.legacy.bak`，失败则恢复旧命名和旧 Compose。

Docker 构建阶段使用 Node 24、锁文件安装、Nuxt build、maintenance bundle；运行镜像只带 `.output`、config、migrations 和入口脚本。图片迁移需要的 Sharp 原生运行包也包含在 maintenance 产物中，服务器无需 tsx 或整套源码。

## 修改生产环境参数

```powershell
pnpm env:build:prod
# 在本机 .env.prod 填写/修改实际值
pnpm env:encrypt
pnpm env:check
```

提交必要 YAML/模板和更新的 `.env.prod.gpg`；不提交明文 `.env.prod`，不把口令写进模板。`env:check` 将密文解密到临时文件，与本地明文按字节比较。仅修改模板后重新构建不会覆盖生成文件中的旧值，需同时核对明文。

## 部署失败与回退

远端脚本在候选切换后的失败路径恢复 `.env.prod.bak`、`docker-compose.yml.bak` 和 pull 前的应用/broker 镜像 ID，并再次检查旧容器。首次引入托管 broker 失败时移除本次新增容器但保留卷，不操作旧 1Panel broker；无旧应用镜像的首次部署仍需人工处理。自动恢复成功后 workflow 仍报告失败，便于追查原因。

数据库迁移是前向步骤，自动回退不会撤销 schema 或外部对象变更。维护迁移必须先在受控窗口执行，不能让 Deploy 的健康门替代切换计划。回退旧应用须先确认它能兼容当前数据库，必要时使用[备份恢复](../operations/backup-recovery.md)。

上述自动回退只覆盖远端 Compose 部署失败，不修改外部反代。若应用已经健康、随后 ESA 发布失败，工作流报错但应用保持新版本；检查 artifact 的阶段与版本，修正后可单独运行生产 ESA 命令。应用与函数不是原子事务，密钥轮换或不兼容协议变更需要协调窗口，不能自动回滚另一侧来掩盖问题。

当前工作流没有 `workflow_dispatch`。需要重新交付旧提交时，使用与目标提交相符的可重跑 workflow，并复核其实际 checkout SHA；不要假定重跑最新 workflow 会自动选择旧代码。历史镜像没有永久 SHA tag，服务器成功后还会清理悬空镜像。

共享宿主机只允许脚本现有的 `docker image prune -f`。不要改为 `-a`，它可能清理其他站点保留但暂未运行的镜像。生产 Compose 的源在仓库，服务器手改会在下一次部署被覆盖。
