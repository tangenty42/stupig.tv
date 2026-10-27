# RAM 配置清单

2026-10-25 已按用户授权建立本页的 10 个用户、7 份策略；8 组应用凭据已写入本机 dev/prod env，生产密文已同步。ACR 改回共用 Tangenty 现有 Registry 凭据，两个新 RAM 用户保留备用。读回结果见[台账](aliyun.md)。

下表用于核对或新环境配置。JSON 位于 [config/ram](../../config/ram/)，后续修改仍需显式应用，不会随代码自动部署到阿里云。权限原理见[策略说明](ram-reference.md)。

## 创建哪些用户和策略

在 RAM → 权限策略中选择脚本编辑，粘贴对应 JSON，策略名称使用文件名去掉 `.json`。再给下表用户绑定该策略。

| RAM 用户（建议名） | 绑定策略 JSON | 凭据去向 |
| --- | --- | --- |
| `stupig-oss-dev` | [stupig-oss-app-dev-access.json](../../config/ram/stupig-oss-app-dev-access.json) | `.env.dev` 的 `ALIYUN_OSS_ACCESS_KEY_ID/SECRET` |
| `stupig-oss-prod` | [stupig-oss-app-prod-access.json](../../config/ram/stupig-oss-app-prod-access.json) | `.env.prod` 的 `ALIYUN_OSS_ACCESS_KEY_ID/SECRET` |
| `stupig-esa-purge-dev` / `stupig-esa-purge-prod` | [stupig-esa-cache-access.json](../../config/ram/stupig-esa-cache-access.json) | 各自 env 的 `ALIYUN_ESA_ACCESS_KEY_ID/SECRET` |
| `stupig-esa-publish-dev` / `stupig-esa-publish-prod` | [stupig-esa-publish-access.json](../../config/ram/stupig-esa-publish-access.json) | 各自 env 的 `ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID/SECRET` |
| `stupig-sms-dev` / `stupig-sms-prod` | [stupig-sms-access.json](../../config/ram/stupig-sms-access.json) | 各自 env 的 `ALIYUN_DYPNS_ACCESS_KEY_ID/SECRET` |
| `stupig-acr-push` | [stupig-acr-push-access.json](../../config/ram/stupig-acr-push-access.json) | 保留备用，当前部署不使用 |
| `stupig-acr-pull` | [stupig-acr-pull-access.json](../../config/ram/stupig-acr-pull-access.json) | 保留备用，当前部署不使用 |

`ID/SECRET` 分别表示两个完整变量名的 `ACCESS_KEY_ID` 和 `ACCESS_KEY_SECRET`，不能填成一个组合变量。开发和生产推荐独立用户、独立密钥；ESA/SMS 的同一份策略可以分别绑定给两个用户，无需复制 JSON。

后补的 ACR 控制台初始化策略已撤销并删除。当前部署仅需 GitHub 的 `ACR_USERNAME/PASSWORD`，具体见 [ACR](github-acr.md)。

## 按这个顺序配置

1. **创建策略**：JSON 已写入当前账号 `1225000469589595`、两个桶、共享 SiteId `181553031729356` 和 ACR 仓库。更换资源时先改相应 JSON；无需创建 STS 上传角色。
2. **创建或沿用用户**：应用、维护、发布、短信身份仅需 OpenAPI 访问。给已有用户补绑正确策略后，检查并移除多余 FullAccess 及用户组授权；新增窄策略不会抵消旧 Allow。当前 ACR 交付沿用现有 Registry 固定密码，不需要给备用 RAM 用户初始化密码。
3. **保存凭据**：按表填写 `.env.dev` / `.env.prod`。两环境分别设置不同的 `ALIYUN_ESA_AUTH_KEY`，填写 `ALIYUN_ESA_SITE_ID=181553031729356`。图形验证的 `ALIYUN_DYPNS_CAPTCHA_APP_KEY` 来自产品控制台，不是 RAM AccessKey。
4. **检查再交付**：运行下面的只读检查。确认生产配置后执行 `pnpm env:encrypt`、`pnpm env:check`，提交更新后的 `.env.prod.gpg`；密文口令对应 GitHub `ENV_PASSPHRASE`。

```powershell
pnpm esa:deploy:dev --check
pnpm esa:deploy:prod --check
pnpm content:preload:check --env=dev
pnpm content:preload:check --env=prod
```

ESA 发布检查不会发布代码；预热检查需要对应数据库可达，但不提交任务。OSS 上传/替换/删除、短信受控号码、ACR 推拉仍需各自验收，不能用审计管理员成功代替应用身份。开发默认保持 OTP debug，不对开发测试号码发送真实短信。

## 三个容易配错的地方

- **ESA 共用站点**：缓存策略作用于整站，发布策略作用于账号支持的函数操作；两个用户名并不提供 RAM 层面的 dev/prod 隔离。CI 的完整生产 env 含发布凭据，服务器与应用只接收剔除发布凭据的运行配置；首次切换前和失败回滚后的旧配置、备份仍需留意，见[权限参考](ram-reference.md)。
- **ACR 个人版**：Registry 密码不是 AccessKey Secret。CI 和主机共用 `ACR_USERNAME/PASSWORD`，使用 Tangenty 现有的 Registry 固定密码，不再要求独立拉取账号。见 [ACR](github-acr.md)。
- **ESA 私有 OSS 回源**：在 ESA 控制台授权产品使用已有服务角色；不要把应用 AccessKey 或临时管理员密钥填进函数变量。函数只需要业务共享密钥、回调 URL 和超时。

## ESA 发布策略

日常发布只绑定上表的通用发布策略，包含上传版本、变量同步、发布和只读路由检查。首次创建函数、修改路由/缓存/安全规则由管理员在控制台完成，不给发布用户追加 ESA FullAccess。详细范围见[策略说明](ram-reference.md)。
