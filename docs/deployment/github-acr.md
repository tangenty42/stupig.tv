# GitHub Actions 与 ACR

事实源：[Check](../../.github/workflows/check.yml)、[Deploy](../../.github/workflows/deploy.yml)、[Maintenance Deploy](../../.github/workflows/maintenance-deploy.yml)、[Dockerfile](../../Dockerfile)、[远端部署脚本](../../scripts/deploy/remote.sh)。

## 仓库设置

在 GitHub 仓库 Settings → Secrets and variables → Actions 配置下表。当前 workflow 未声明 GitHub Environment，因此应配置 Repository Secrets/Variables，不能只放在尚未被 job 引用的 Environment 中。入口和权限说明见 [GitHub 官方文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | `ACR_IMAGE` | 完整 `registry/namespace/repository`，不带 tag；与生产 env 中同名项一致 |
| Variable | `SSH_HOST`、`SSH_PORT`、`SSH_USER` | 可从 GitHub runner 访问的服务器及部署账号 |
| Variable | `DEPLOY_DIR` | 服务器上已经创建、部署账号可写的绝对目录 |
| Variable | `MYSQL_BACKUP_CONTAINER` | 可选，维护备份使用的同主机 MySQL 容器名；省略时取应用 DB host |
| Secret | `ACR_USERNAME`、`ACR_PASSWORD` | CI 推送与服务器拉取共用的 Registry 登录凭据；当前沿用 Tangenty 的 ACR 固定密码 |
| Secret | `SSH_PRIVATE_KEY` | 部署账号对应私钥 |
| Secret | `SSH_KNOWN_HOSTS` | 经独立渠道核实的 SSH 主机公钥，采用 OpenSSH known_hosts 格式，含主机名和端口 |
| Secret | `ENV_PASSPHRASE` | 解密已提交 `.env.prod.gpg` 的口令 |

GitHub Ruleset 的必需状态检查：`check`、`changes`、`migrations`、`mqtt` 与三个 `browser (N/3)` 分片共七项，均来自 GitHub Actions；同时启用"合并前分支必须最新"（strict），创建分支/仓库时不强制检查。被 `if` 跳过的 job 在分支保护中按成功上报，因此纯文档 PR 跳过应用检查也能满足全部必需检查；`verified-tree` 未列入必需项。

`unit` 执行 lint、类型和单元／组件检查；`browser-css` 与三个应用浏览器分片并行。原必需状态 `check` 汇总 unit、MQTT、浏览器、CSS 和迁移结果，任一失败或意外跳过都会失败，因此拆出 CSS 后无须更改已有 Ruleset 即可维持合并门槛。

Actions 权限选择 "Allow tangenty42, and select non-tangenty42, actions and reusable workflows"，勾选 "Allow actions created by GitHub"，允许列表加入 `pnpm/action-setup@*`（各工作流唯一的非 GitHub 官方 action，缺失它相关工作流会拒绝启动），并启用 "Require actions to be pinned to a full-length commit SHA"；各工作流的 action 引用已全部固定到完整提交 SHA。Linux 部署主机需有 Docker Compose、`flock` 和 `sha256sum`。

### SSH 主机身份

启用此版本 Deploy 前，先通过服务器控制台等独立可信渠道读取 `/etc/ssh/ssh_host_ed25519_key.pub`，并用 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 核对指纹。将公钥类型和内容写入 GitHub Repository Secret `SSH_KNOWN_HOSTS`，格式为 `[主机名]:端口 ssh-ed25519 公钥内容`；端口为 22 时使用 `主机名 ssh-ed25519 公钥内容`。可放入多行以支持换钥过渡。主机公钥不是部署账号的公钥或私钥。不要直接信任部署时 `ssh-keyscan` 获得的值；如使用扫描结果，须先与独立渠道取得的指纹比较。

Deploy 在构建前检查该 Secret 含目标主机条目，SSH 和 SCP 强制验证主机密钥；Secret 缺失、主机或端口不匹配、密钥变更均会使部署失败。更换服务器或主机密钥时，先独立核对新公钥并更新 Secret，再进行部署。工作流使用的第三方 Action 固定到提交 SHA，更新版本时应核实上游提交后同步修改。

## ACR 准备

创建命名空间与私有镜像仓库，从该实例的访问凭证页面取得实际 registry 和登录名。ACR 新旧个人版地址不同，不能从旧示例猜 registry；按[官方推送/拉取指南](https://help.aliyun.com/zh/acr/user-guide/use-a-container-registry-personal-edition-instance-to-push-and-pull-images)取得地址。企业版也使用实例提供的访问入口和凭据。

首次上线确认 GitHub runner 可登录/推送，服务器可登录/拉取同一仓库。云端草稿版本起流程额外发布应用 `:<checkout SHA>` 和 EMQX `:mqtt-<checkout SHA>`，保留 latest/mqtt 别名，不由 ACR 自动构建。push 后读取实际 RepoDigest，运行 env 的 APP_IMAGE/MQTT_IMAGE 固定到 digest；SSH 失败不会把远端 ACR 标签改回旧版本。

2026-10-25 的 API 历史核对为仓库 PRIVATE/NORMAL、仅一个 latest、无自动构建规则；当时未验证 GitHub 登录凭据或服务器拉取，也未实现固定 tag/digest。2026-10-30 的工作区改动不能替代云端读回；实际资源见[ACR 台账](aliyun.md)。

## 推拉身份

当前按用户决定恢复单套凭据：CI 和生产主机均使用 GitHub `ACR_USERNAME/PASSWORD`，沿用 Tangenty 已有的 ACR Registry 固定密码。用户名从访问凭证页面的 Docker 命令复制；这里不使用阿里云控制台密码或 AccessKey Secret。[官方凭据说明](https://help.aliyun.com/zh/acr/user-guide/configure-access-credentials)。

workflow 在构建前检查两项凭据非空，不再要求独立 pull 身份。服务器获得相同的 Registry 推拉能力。凭据通过 SSH 的加密 stdin 与部署脚本一起传递；base64 只处理 shell 引号，密码通过 Docker `--password-stdin` 输入。

当前 GitHub `SSH_USER` 为 `root`，部署密钥可获得宿主机管理权限；服务器还持有可推送的 ACR 凭据，详见 [RAM 权限边界](ram-reference.md)。改为受限部署身份、拆分 ACR 凭据需要配合服务器和凭据交付方式调整，不能仅靠更改工作流认定已实现最小权限。

目标使用新个人版域名，[官方限制](https://help.aliyun.com/zh/acr/user-guide/individual-edition-instance-independent-domain-name-capacity-limit)仅允许一个 RAM 子账号设置 Registry 密码，因此不再推进双 RAM 方案。已创建的 push/pull 用户及仓库策略保留备用，不参与当前交付；额外控制台初始化策略已撤销并删除。

## CI 到部署的实际顺序

1. Pull Request 和非纯文档的 main push 触发 Check。Node 24、pnpm 12.10.1，运行 settings 一致性、lint、Nuxt typecheck、脚本 typecheck、Vitest；纯文档 PR 跳过应用检查，纯文档 main push 不触发 Check 或 Deploy。
2. 独立 Check jobs 验证真实生产 MQTT 镜像的权限与重启持久化、Chromium 浏览器流程，以及全新 MySQL 8.4 的完整 SQL/TS 迁移、第二遍幂等执行、隔离迁移框架和 Content 转换。main 可在确认 PR 所有检查成功且代码树一致时复用这些结果；否则完整重跑。CI 的存储边界夹具不代表真实生产 OSS/ESA 已验收。
3. main 的 Check 成功触发 Deploy，检出该次 Check 的 `head_sha`；部署同组串行，不取消正在执行的旧部署。Deploy 仅接受 `push` 事件且来源为本仓库的 Check run：`workflow_run` 的 `branches` 过滤按触发 run 的 head 分支名匹配，而 fork 的默认分支同样叫 `main`，纯文档 fork PR 的成功 Check 若无事件守卫，就能借默认分支上下文的全部 secrets 与 root SSH 触发部署。安装发布工具时使用锁文件并禁用安装脚本。
4. runner 用 GPG 解密 `.env.prod.gpg`，先运行 `pnpm esa:deploy:prod --check` 核对函数、路由和凭据；从完整配置生成不含 `ALIYUN_ESA_PUBLISH_*` 的 `.env.prod.runtime`，推送应用 SHA 与 broker mqtt-SHA tag 及兼容别名，再写入实际 digest 和协议标记。运行 env 先通过 SCP 上传到权限为 700 的临时目录，文件权限 600，再原子替换 `.env.prod.incoming`；Compose 另上传为 `docker-compose.yml.incoming`。明文不会打进镜像。
5. SSH 将 `scripts/deploy/remote.sh` 交给远端 shell。脚本取得主机发布锁，在私有目录校验并拉取候选镜像，用该镜像只读检查完整迁移链。维护迁移、首次跨入 cloud-v1 或 SQL 恢复要求都会在替换正式配置、停止旧应用之前拦截发布；日志给出固定计划 ID。候选环境、Compose 和计划保存在权限为 700 的 `.release-plans/<ID>/`。
6. 普通发布通过预检后才备份和切换旧 env/Compose，再启动两个服务。应用依赖 EMQX 凭据健康检查；远端另对两个服务依次执行健康门，默认各最多 72 次、间隔 5 秒。容器退出或重启循环立即失败；还须通过公网首页、健康响应、公开及草稿 WSS 的 MQTT 连接和拒绝矩阵，才清理悬空镜像。WSS 反代配置仍需单独交付，缺失或接错 listener 会使发布失败，见 [MQTT](mqtt.md)。
7. 健康门成功后运行 `pnpm esa:deploy:prod`，同步函数变量、创建并发布本次代码版本，读回确认。目标统一来自 prod YAML 的 `esaFunction`，无需在工作流中重复函数名或回调。
8. 无论成功或失败，清理 runner 明文 `.env.prod` 和 `.env.prod.runtime`，上传不含密钥的 `esa-production-receipt` artifact，保留 30 天。发布详情与首次资源准备见[函数发布](esa-functions.md)。

服务器正式文件统一为 `.env.prod`，所有部署 Compose 调用显式使用 `--env-file .env.prod`。首次从旧版 `.env` 升级时，脚本保留旧文件作为回滚来源；新容器健康后才将旧文件移到 `.env.legacy.bak`，失败则恢复旧命名和旧 Compose。

完整生产 env 仍保存在 CI 解密文件与本地加密源中，服务器正式文件只含运行及维护所需变量。首次切换期间旧环境和回滚备份可能仍含发布凭据：成功后脚本尝试从 `.env.prod.bak` 和 `.env.legacy.bak` 删除 `ALIYUN_ESA_PUBLISH_*`；只自动处理可安全识别的单行配置，遇到多行、转义等不支持的格式会保留原文件并在部署日志中警告，需人工检查处理。部署失败回滚时保留原样的旧配置和备份；其他历史备份也不会自动清理。应用原先已经接触过的密钥不会因删除变量而自动失效，如需收回历史访问能力须另外轮换发布凭据。

解密后立即为 env 中按名称识别的密码、密钥和令牌注册 GitHub 日志遮罩，再执行预检和部署；应避免输出任何机密，遮罩不保证覆盖编码或变形后的值，也不保护 artifact。应用或 broker 健康检查失败时，远端脚本在回滚前将最后 80 行原始容器日志保存为部署目录下仅所有者可读写的 `.deploy-failure-<服务名>.*.log`，CI 只输出状态、文件位置和回滚结果。服务器诊断日志可能包含敏感内容，分享前先检查，不再需要时按服务器保留策略清理；创建或读取日志失败会在 CI 明确提示。

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

普通发布失败后，只有数据库仍为原状态或仅完成了预检允许的兼容在线迁移，脚本才恢复 `.env.prod.bak`、`docker-compose.yml.bak` 和 pull 前的应用/broker 镜像，并重新检查旧容器。恢复的 digest 引用不重新打 tag。出现失败／不明回执、未批准的迁移、数据库身份改变，或首次跨入 cloud-v1 且新进程可能已服务请求时，失败改为停应用并保留现场。维护迁移命令一旦开始，无论同不同协议都不自动启动旧写者；仅备份阶段失败、尚未执行生产迁移时可以恢复此前运行的旧服务。首次引入 broker 的安全回退路径只移除新增容器并保留卷，不操作旧 1Panel；无旧镜像仍需人工处理。

数据库迁移是前向步骤，自动回退不会撤销 schema 或外部对象变更。维护迁移必须先在受控窗口执行，不能让 Deploy 的健康门替代切换计划。回退旧应用须先确认它能兼容当前数据库，必要时使用[备份恢复](../operations/backup-recovery.md)。

上述自动回退只覆盖远端 Compose 部署失败，不修改外部反代。若应用已经健康、随后 ESA 发布失败，工作流报错但应用保持新版本；检查 artifact 的阶段与版本，修正后可单独运行生产 ESA 命令。应用与函数不是原子事务，密钥轮换或不兼容协议变更需要协调窗口，不能自动回滚另一侧来掩盖问题。

普通 Deploy 仍由成功的 main Check 触发；独立的 **Maintenance Deploy** 使用 `workflow_dispatch`，只允许从 main 运行。重新交付旧提交须核实其实际 checkout SHA、schema 与草稿协议；旧流程没有 SHA tag，不能假定重跑最新 workflow 会选旧代码。`application-production-receipt` artifact 记录 commit、应用（含 maintenance 包）和 broker digest、schema、共享 settings 摘要及 cloud-v1 标记，保留 30 天；须另备长期恢复材料并核验镜像仍存在。该记录证明构建身份，不证明生产健康或外部反代已验收。

## 授权维护发布

1. 查看被拦截的 Deploy 日志，核对提交、待执行迁移及其影响，并取得 64 位计划 ID。维护窗口中应用和随应用运行的任务将停止；外部 worker／cron 必须由操作者提前停用。合并 PR、普通 Deploy 重跑不构成停写授权。
2. 在 Actions → **Maintenance Deploy** 填写 `plan_id`，勾选 `confirm_maintenance`，点击 Run workflow。也可在核对计划后由获授权的代理使用 CLI 触发同一入口；同一计划不重复要求批准各个子步骤。
3. 工作流从服务器读取该计划，检出其中的确切 commit，先检查 ESA 发布配置，然后复用已经固定的应用和 broker digest。主机再次核对原运行版本、配置摘要、目标数据库身份、完整迁移清单和账本；任何变化都要求重新预检，不自动扩大授权或重新构建镜像。
4. 停止旧应用，再次核对计划；通过同主机 MySQL 容器执行一致性备份、隔离恢复和全部表数据的字节比较。默认容器名取应用 DB host；其为网络别名时，仓库变量 `MYSQL_BACKUP_CONTAINER` 指定实际容器名，服务 UUID 必须与应用连接一致。当前适配器要求 root 凭据在该容器的 `MYSQL_ROOT_PASSWORD` 中、表为 InnoDB，没有 view/trigger/routine/event 或跨库外键，且目标库没有其他连接；不满足就停止，不绕过验证。远程 DB 需要专用适配器。
5. 验证备份后执行同镜像 `--maintenance`，核对完成回执和适用的数据基线，再启动新应用并执行健康／公网验收，最后发布同 commit 的 ESA 函数。维护开始后的失败保留停写现场，备份和日志位于计划目录；没有自动数据库 down。

CLI 授权同一入口（需要仓库写权限）：

```sh
gh workflow run maintenance-deploy.yml --ref main -f plan_id='<完整计划 ID>' -F confirm_maintenance=true
```

备份文件、运行配置及原始备份／迁移错误只保存在服务器私有计划目录，不上传到 CI artifact。临时 QA 库在验证结束后删除；备份保留期、加密及异地副本由服务器策略管理。这个适配器验证数据库恢复，不承诺撤销迁移已经发出的 OSS 等外部副作用。`maintenance-production-receipt` 保留批准计划、本次执行的应用就绪回执及 ESA 回执；应用就绪回执绑定 run ID/attempt，阶段结果以 workflow jobs 和服务器日志为准。

共享宿主机只允许脚本现有的 `docker image prune -f`。不要改为 `-a`，它可能清理其他站点保留但暂未运行的镜像。生产 Compose 的源在仓库，服务器手改会在下一次部署被覆盖。
