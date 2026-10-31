# 文档导航

这里描述当前仓库的业务、实现和操作方式。开发约束由 [.github 指令](../.github/copilot-instructions.md)维护，具体部署值以配置/schema、脚本和策略文件为准。全部 pnpm 入口与脚本职责见[命令与脚本清单](development/commands.md)。

## 阅读顺序

1. 阅读[业务、架构与依赖总集](architecture.md)，了解角色、数据和请求链路。
2. 开发从[本地环境](development/README.md)开始，部署从[部署总流程](deployment/README.md)开始。
3. 修改某个功能前阅读对应模块，再查源码和测试。
4. 升级已有环境前阅读[迁移工具](operations/migrations.md)；旧 Content 数据另走[切换手册](operations/content-cutover.md)。

## 开发

| 文档 | 用途 |
| --- | --- |
| [本地环境](development/README.md) | 安装、环境文件、整套服务启动和常用命令 |
| [测试](development/testing.md) | 单元、类型、脚本、浏览器和外部服务验证 |
| [开发授权隧道](development/auth-tunnel.md) | frps/frpc、HTTPS 回调、代理及故障定位 |

## 部署

[部署总流程](deployment/README.md)负责依赖顺序、环境关系、上线与验收；下列文档负责各项具体设置。

| 文档 | 用途 |
| --- | --- |
| [配置填写清单](deployment/configuration.md) | 生成 env、按表填值、加密交付 |
| [配置项参考](deployment/configuration-reference.md) | 覆盖规则、字段来源、默认值和公开边界，按需查阅 |
| [阿里云资源与生产方案](deployment/aliyun.md) | ACR/OSS/ESA 实际资源、云端差异、权限边界和上线阻塞 |
| [GitHub 与 ACR](deployment/github-acr.md) | CI/CD、变量与 Secrets、GPG、镜像与发布 |
| [服务器](deployment/server.md) | Docker 网络、反向代理、TLS、健康检查与升级 |
| [MySQL 与 Redis](deployment/mysql-redis.md) | 数据服务、连接、持久化及权限 |
| [MQTT](deployment/mqtt.md) | EMQX、TCP/WSS、发布和订阅权限 |
| [RAM 创建清单](deployment/ram.md) | 创建哪些用户、绑定哪份 JSON、凭据填哪里 |
| [RAM 权限参考](deployment/ram-reference.md) | 各策略的边界、共享范围和官方依据，按需查阅 |
| [短信与 CAPTCHA](deployment/sms-captcha.md) | 产品接入、模板、域名、调试开关 |
| [OSS](deployment/oss.md) | 私有桶、分片签名、CORS、版本、生命周期 |
| [ESA](deployment/esa.md) | DNS、原生缓存、缓存键、响应头、回源和规则次序 |
| [ESA 函数](deployment/esa-functions.md) | 在线授权、路由、环境快照和显式版本发布 |

## 功能模块

| 文档 | 用途 |
| --- | --- |
| [账号与权限](modules/accounts.md) | 登录、会话、资料、管理与授权 |
| [实时同步](modules/realtime.md) | MQTT、BroadcastChannel、SSR、轮询、Content outbox |
| [外部集成](modules/integrations.md) | 外部信息获取与缓存边界 |
| [后台工作](modules/background-jobs.md) | runner 模式、七类扫描、资源槽、租约和退出 |
| [Content 总览](modules/content/README.md) | 档案、附件、关键状态与模块导航 |
| [工作区](modules/content/workspace.md) | 树结构、命名、路径约束、resolve 和批量操作 |
| [上传](modules/content/uploads.md) | 预约、分片、续传、替换、取消及发布 |
| [图片](modules/content/images.md) | 格式、编辑、原图、另存为与删减版 |
| [Markdown](modules/content/markdown.md) | 方言、引用、卡片、预览与诊断 |
| [草稿](modules/content/drafts.md) | 云端共享、独占租约、断线交接、发布与引用历史 |
| [读取权限](modules/content/access.md) | 机密继承、普通/删减版本、下载和授权撤销 |
| [对象生命周期](modules/content/object-lifecycle.md) | 预热、退役、刷新和对象清理 |

## 运维

- [迁移工具](operations/migrations.md)：SQL/TS 版本链、冻结、状态、维护执行及失败恢复。
- [Content 切换](operations/content-cutover.md)：历史数据转换、源保留、预演和上线窗口。
- [OSS 对账](operations/storage-audit.md)：自动全桶元数据扫描、异常分类、进度与默认关闭的孤立对象清理。
- [备份恢复](operations/backup-recovery.md)：数据库、对象版本、密钥材料和代码回滚的配套关系。
- [故障排查](operations/troubleshooting.md)：从症状定位配置、授权、存储、后台工作和部署故障。

## 部署状态与能力边界

2026-10-28 的[架构与文档一致性审查](reviews/architecture-and-documentation-audit-2026-10-28.md)独立记录架构评估、已发现的说明偏差及逐项决策选项；它是审查记录，不替代下列手册或线上验收。

2026-11-01 的[长期问题与优先级](reviews/long-term-issues-2026-11-01.md)以 #55 合并后的代码为基线，集中列出恢复、发布保留、容量预算、账本及通知等剩余事项的建议顺序、触发条件和完成标准；已完成项与暂停的旧浏览器验证另行标明。

2026-10-29 的[共享云端草稿与编辑租约设计](designs/shared-cloud-draft-2026-10-29.md)记录 A02 的协议与选择。共享云端 draft、服务端租约及内存编辑会话已于 2026-10-30 随 [PR #48](https://github.com/tangenty42/stupig.tv/pull/48) 合并，旧 localStorage 由管理员自行处理；合并状态不代表生产已切换。

2026-10-30 的[共享云端草稿实现方案与记录](designs/shared-cloud-draft-implementation-2026-10-30.md)按 P0–P6 对应审计 A01–A10、D01–D20，记录实际落点、隔离验证、容量边界和未完成的独立审计项；该记录不作为生产上线回执。

CSS 当前采用[官方主题 API 与 Tailwind 选择器策略](reviews/css-official-apis-validation-2026-10-29.md)，已随 [PR #46](https://github.com/tangenty42/stupig.tv/pull/46) 合并。此前 Firefox 78 因缺少 Web Locks 而只读，随后已由服务端租约替换；旧引擎编辑流程的隔离验证见[共享云端草稿实施记录](designs/shared-cloud-draft-implementation-2026-10-30.md)。完整浏览器覆盖与生产交付需按证据单独验收。未采用的自定义 CSS 分层插件长篇提案已移出当前文档，保留[公开 API 可行性结论](reviews/css-layer-public-api-feasibility-2026-10-29.md)及 Git 历史供回查。

2026-10-31 的 [PR #49](https://github.com/tangenty42/stupig.tv/pull/49) 已合并迁移预检和按计划授权的维护发布入口，操作方式见[GitHub 与 ACR](deployment/github-acr.md)。[PR #52](https://github.com/tangenty42/stupig.tv/pull/52) 已将 CSS 验证移到独立 `browser-css` CI job，并保留汇总门禁，见[CSS 发布准备](deployment/README.md#css-样式变更发布准备)。上述合并状态已按提交记录核对。

2026-11-01 已通过 Actions API、发布回执及 SSH 只读核对 #54 交付：应用／broker 镜像与回执一致，两个容器健康，生产迁移 30 项完成；用户随后手动完成本轮生产业务验收并反馈无异常。最新生产状态与证据边界统一见[云端台账](deployment/aliyun.md#截至-2026-11-01-的发布信息)。

下表保留各操作手册记录的部署范围与能力边界；当前线上版本须用发布回执及镜像身份核验，不能从本地改动或 PR 合并推断：

| 事项 | 状态与下一步 |
| --- | --- |
| 生产 Content 迁移 | 2026-10-25 已完成生产副本预演、正式维护切换及静态资源迁移；保留恢复材料，见切换手册 |
| 生产云端配置 | 2026-10-25 记录 OSS、ESA 路由/函数和 RAM 已核对并上线，当时真实生产用户上传/编辑及生产预热待验收、预热关闭；最新状态按云端台账及回执核验 |
| OSS 全桶对账 | 2026-10-25 首轮生产扫描为 405 个引用、313 个当前对象且无异常；自动清理实现已合并，仓库默认关闭，生产实际开关与后续扫描结果须按回执核验；启用前先观察一至两周 |
| ESA 历史规则异常 | 曾出现旁路与规则字段交互问题；部署文档保留需要验证的组合，不假定厂商已修复 |
| 通用任务内核 | 当前只有共享调度外壳和领域账本；通用 job/attempt/step 及跨进程容量尚未实现 |
| 生产独立 worker | 源码命令已实现，生产精简镜像及 Compose 尚未交付 worker/status CLI；现行生产使用 app 模式 |
| 官方 CSS API 接入 | 代码已合并，限定生产构建 / 旧引擎场景已有验证；完整浏览器覆盖与真实交付另行核验，见 CSS 当前路线 |
| 业务恢复 | 当前没有自助回收站和通用自动数据回滚；按备份恢复手册操作 |

## 文档维护方式

- 描述当前行为；历史决策只在解释仍有效的约束时保留必要背景。
- 一个主题由一份文档负责，其他页面链接过去。配置默认值、权限 JSON 和脚本参数以实际文件为准。
- README 保留项目介绍和作者表达，提供操作入口；业务与架构放总集，功能细节放模块文档，部署与恢复步骤放对应手册。开发规范放 `.github` 指令，测试方法放测试指南，不在各处复制整套规则。
- 云控制台说明注明官方依据与核对范围；没有实际读取控制台就不写成『已配置』。
- 变更同步更新对应说明、入口链接及验证方式，不追加新的阶段报告文件。
- 重写或移动前核对历史，保留作者原有的 POV、整活、排障故事和配图。用[保护标记](../.github/instructions/code-style.instructions.md)明确范围；标记内容及关联配图的删除、迁移、改写或格式调整，必须按[授权规则](../.github/copilot-instructions.md)先说明方案并征得用户同意。技术说明过期时也先提出修订或迁移方案，不以维护准确性为由擅改受保护内容。
- 业务描述不写凭据值。示例应使用明确占位符，并区分开发、生产和隔离验证。

2026-10-24 重建前的 docs、README 及开发指令已在本机 `.data/documentation-backup-20261024-214013/` 备份，包含逐文件 SHA-256 清单。该目录被 Git 和镜像构建忽略，仅用于本次回查；新检出仓库不包含这份本机备份，当前文档不依赖它。
