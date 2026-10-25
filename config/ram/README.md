# RAM 策略文件

[创建用户、绑定策略、填写凭据的操作清单](../../docs/deployment/ram.md)。本目录仅提供策略 JSON 和说明，不自动修改云端授权。

2026-10-25 已显式应用这 7 份策略并读回一致；后补的 ACR 控制台初始化策略已撤销并删除。后续文件变更仍需人工应用或单独获授权的工具执行。[当前用户与验证结果](../../docs/deployment/aliyun.md#ram-与-acr-的收敛)。

| 文件 | 用途 |
| --- | --- |
| `stupig-oss-app-dev-access.json` | Content、头像和静态资源的开发桶应用读写 |
| `stupig-oss-app-prod-access.json` | Content、头像和静态资源的生产桶应用读写 |
| `stupig-esa-cache-access.json` | 共享 ESA 站点刷新、预热、任务及额度查询 |
| `stupig-esa-publish-access.json` | 两环境发布用户共用的函数发布能力 |
| `stupig-sms-access.json` | PNVS 短信发送、核验 |
| `stupig-acr-push-access.json` | 指定仓库推送及拉取，保留备用；当前部署不使用该 RAM 用户 |
| `stupig-acr-pull-access.json` | 指定仓库仅拉取，保留备用；当前部署不使用该 RAM 用户 |

资源固定为当前账号和项目：修改账号、OSS 桶、ESA 站点或 ACR 仓库时同步审阅 JSON 与云端授权。两份 OSS 策略的权限相同、目标桶不同；其他能力共用策略文件，用户和密钥仍按用途/环境分开。

两份 OSS 策略已更新为 v2：在原有 `content/att/` 权限之外，增加精确 `imgs/*` 与 `avatar/*` 对象读写、ACL 和非永久删除；未授予全桶对象读写或历史版本永久删除。

后续 v3 增加指定桶的 `oss:ListObjects`，供 runner 全桶元数据对账；不扩大对象内容读取、写入或删除范围。

当前浏览器上传使用精确 UploadPart 签名，不使用 AssumeRole。原先两份未使用的上传角色策略已移除，旧云角色已清理；dev/prod 的保留字段 `uploadRoleArn` 均设为 null。源码冻结迁移引用的材料不属于本目录，不能跟随清理修改。
