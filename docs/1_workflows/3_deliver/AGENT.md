# AGENT：构建与部署核对记录

- 本文档状态：DONE（文档迁移与去重完成；生产衔接项仍按下文在发布时核对）
- 覆盖范围：发布实现与 DESIGN 的对应、外部待办、历史发布证据和旧文档归属
- 旧文档：`docs-legacy/` 已于 2026-11-19 删除；本文提到的旧手册、旧台账以及“留在原文”的内容，原文都在 git tag `docs-legacy-final`
- 核对基线：2026-11-11 00:16:40 +08:00（Asia/Shanghai）；提交 `722c1cd3392cb4cdb5c8b051f3354c8e3905e355` 加本轮未提交工作区
- 权威依据：[SID#1.3.DESIGN](DESIGN.md)
- 操作补充：[SID#1.3.AGENT-DESIGN](AGENT-DESIGN.md)

本轮读取工作流、部署及 ESA 源码、现行文档和旧手册，迁入仍适用的操作说明。未执行构建、发布、迁移、云端查询或生产业务验收；本轮时间不替代下表的历史核对日期。

## 实现对应

| DESIGN 要求 | 当前实现与证据 |
| --- | --- |
| Check 成功后自动发布 | [Deploy](../../../.github/workflows/deploy.yml) 只接收本仓库 main 的成功 push Check，检查候选与当前 main 的运行时代码差异；固定提交及镜像 digest |
| 维护迁移先确认计划、停写、备份验证 | [Maintenance Deploy](../../../.github/workflows/maintenance-deploy.yml) 检出批准提交、复用镜像；[远端脚本](../../../scripts/deploy/remote.sh) 在停应用前后复核计划，再备份、迁移、验收 |
| 健康检查通过后发布 ESA | [公网验收](../../../scripts/deploy/verify-public.ts) 覆盖 HTTP 与两路 WSS 的规定检查，迁移完成后保存应用回执；runner 随后发布 ESA |
| 失败根据数据状态恢复或停服 | [release.ts](../../../scripts/deploy/release.ts) 检查数据库身份、迁移清单和账本；维护迁移开始后不自动恢复旧写者 |
| 单独 ESA 发布、失败后核对版本 | [cli.ts](../../../scripts/esa/cli.ts) 保存逐阶段记录；[deploy.ts](../../../scripts/esa/deploy.ts) 只读预检、同步变量并核对精确新版本，没有自动回退另一端 |

本轮未发现上述 DESIGN 主流程与实现冲突。DESIGN 保持简明操作入口，细节由 AGENT-DESIGN 补充；新增补充文档本身不表示生产已部署此工作区。

## 下次发布要闭合的事项

| 事项 | 当前证据 | 完成条件 |
| --- | --- | --- |
| 生产 ESA 授权回调换路径 | [2026-11-09 初次配置复核](../0_setup/AGENT.md#2026-11-09-复核与待办) 仍为 `/api/content/authorize`；[prod.yaml](../../../config/prod.yaml) 和 [ESA 配置校验](../../../scripts/esa/config.ts) 使用 `/api/hooks/esa/authorize`，应用入口为 [authorize.post.ts](../../../server/api/hooks/esa/authorize.post.ts)。用户已决定随下次部署同步 | 应用就绪后发布同一版本的 ESA，读回 `CONTENT_AUTH_URL`，用真实附件核对允许与拒绝、HEAD／Range、缓存命中后撤权；不提前手改线上回调 |
| 保留当前可用恢复材料 | 旧记录保存了历史 digest、配置密文与 ESA 版本，Actions 回执仅保留 30 天；没有本轮存续性核验 | 需要建立新恢复点时核对实际运行提交、镜像可取得、配置和口令可恢复，以及相容数据库／对象版本；结果落到维护记录 |
| 本次修改对应的生产业务验收 | 自动健康检查不含真实账号编辑、附件写入及全部视觉场景；11/09 云端控制面复核也未重跑这些场景 | 按实际发布内容记录时间、提交、测试范围和结果，沿用对应领域验收标准；不把历史通过或本地测试扩展为新版本已通过 |

生产预热、自动清理及定期备份属于 [SID#1.4](../4_maintain/AGENT-DESIGN.md)，不因发布流程成功自动视为启用或验收完成。

### 2026-11-26 生产只读预检

- 生产迁移预检判定需要维护发布。待执行 5 项，包括登记存量库基线、转换账号权限、删除旧附件存储字段、将旧删减版迁成独立文件、清空旧 bcrypt 密码。账本无须走 SQL 部分执行恢复流程。
- 3 个普通账号命中旧权限转换。附件表有 162 行，未见非阿里云记录或残留加密密钥。2 个旧删减版都符合迁移条件，目标名称无冲突，所需大小和 ETag 均存在。
- 4 个账号均有待清空的旧密码。人类确认其中使用测试手机号的账号走用户名登录。发布后由管理员在该账号个人主页修改密码，再验证用用户名和新密码登录。
- 生产 ESA 路由预检通过，当前回调为 `/api/content/authorize`，候选回调为 `/api/hooks/esa/authorize`。维护窗口须覆盖应用和 ESA 两端切换以及附件读取冒烟。
- `pnpm settings:check`、`pnpm env:check` 和 31 项定向工具测试通过。密文校验通过 `.env.dev` 中的项目口令完成。维护计划 ID 在候选提交触发 Deploy 并通过服务器预检后生成。

## 历史证据与已接受的边界

| 日期及来源 | 可继承的记录 | 保留边界 |
| --- | --- | --- |
| 2026-11-01 发布材料核对（`docs-legacy/deployment/github-acr.md`） | #54／#55 对应 app、broker、ESA 版本及密文身份曾核对，具体 digest 和链接保留在原记录 | 是当日保留点，非当前线上版本，也不保证今天仍能拉取镜像或下载当时 artifact |
| 2026-11-01 WebP 维护发布（`docs-legacy/deployment/aliyun.md`） | 存量转换、备份隔离恢复及抽样读取有记录；生产维护发布已完成 | 不推导之后的原生图片持久化实现已上线，原记录保留真实账号上传／编辑的验收边界 |
| 2026-11-01 生产业务反馈（`docs-legacy/deployment/aliyun.md`） | 用户曾确认所列业务场景，并提出取消机密后旧名称问题；后者在 #55 补修后仍需按记录复验 | 不把用户反馈扩展成所有 HTTP、缓存、回源协议都有逐请求证据，也不重开已确认的全部旧待办 |
| 2026-11-01 静态资源与旧标签页（`docs-legacy/deployment/github-acr.md`） | 上一版独有 JS 曾返回 404；用户考虑凌晨发布及当时用户规模，接受此阶段风险，暂不补旧资源保留或跨版本标签页验证 | 不是当前收尾阻塞；用户规模或使用方式变化、实际出现 chunk 故障时再评估。重载与未保存编辑的配合仍未因此被验证 |
| 2026-11-09 [云端复核](../../../config/ram/CLOUD-AUDIT-2026-11-09.md#esa-站点与交付配置) | 路由、变量类型和原生规则已有带日期读回；生产回调差异见上表 | 不代替证书实际协商、冷回源、真实附件授权或本轮生产验收 |

## 旧文档迁移对照

| 旧章节 | 当前归属 | 旧资料继续保留的理由 |
| --- | --- | --- |
| github-acr：CI 顺序、失败与回退、授权维护发布（`docs-legacy/deployment/github-acr.md`） | [普通发布与准入](AGENT-DESIGN.md#普通发布与准入)、[授权维护计划](AGENT-DESIGN.md#授权维护计划)、[失败处理](AGENT-DESIGN.md#失败后先确认停在哪一步) | 同文件还保存初次配置、历史发布身份及回执；其他旧手册仍引用它 |
| github-acr：回执、配置与密钥位置（`docs-legacy/deployment/github-acr.md`）及运行期日志说明 | [日志与回执](AGENT-DESIGN.md#日志与回执)；带日期的存续性证据留本文件历史表 | 原记录含当日证据、到期日、核对范围，不能改写成今天仍有效 |
| esa-functions：命令、发布步骤、失败与锁（`docs-legacy/deployment/esa-functions.md`） | [单独发布 ESA](AGENT-DESIGN.md#单独发布-esa)、[ESA 失败、锁与业务验收](AGENT-DESIGN.md#esa-失败锁与业务验收) | 还含初次资源说明、协议实现及历史开发核对，分别属于 SID#1.0 与领域资料 |
| esa-functions：签名升级的维护切换（`docs-legacy/deployment/esa-functions.md`） | [协议或鉴权密钥变更](AGENT-DESIGN.md#协议或鉴权密钥变更) | 原 v2 切换与旧 MD5 拒绝的历史协议上下文继续保留 |
| server：启动与维护、健康日志退出（`docs-legacy/deployment/server.md`） | 本主题发布边界；产物、进程、备份和排障归 SID#1.4，反代初配归 SID#1.0 | 主机与反代示例已在 SID#1.0 |
| 部署清单：CSS 发布准备（`docs-legacy/deployment/README.md`） | [前端资源随版本交付](AGENT-DESIGN.md#前端资源随版本交付)；测试门槛归 SID#1.2 | 原审查材料和历史兼容验证范围尚有独立价值；旧 `verified-tree` job 名称不再沿用 |
| aliyun 云端与发布台账（`docs-legacy/deployment/aliyun.md`） | 本文件历史证据、待办；现行云资源配置见 SID#1.0 | 包含跨阶段证据、规则 ID 和资源快照，不把整份历史台账复制成当前状态 |

重复操作正文已改为现行入口，本阶段 TMP 已删除；旧手册保留原章节锚点、初配示例、协议细节和带日期的发布证据。旧版本号、云配置和未验收事项保留各自日期，不整体继承“当前”字样。统一收尾结果见 [流程整理记录](../../AGENT.md#流程草稿与索引退役记录)。
