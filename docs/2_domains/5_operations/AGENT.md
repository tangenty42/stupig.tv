# AGENT：运行与维护设施的裁定、出入与待办

- 本文档状态：PENDING（初稿，待人类审阅）
- 覆盖范围：本板块的人类裁定、与总体文档的分工、代码里发现的出入、待办
- 旧文档：`docs-legacy/` 已于 2026-11-19 删除；本文提到的旧手册、旧台账以及“留在原文”的内容，原文都在 git tag `docs-legacy-final`
- 核对基线：2026-11-15 00:01:32 +08:00（Asia/Shanghai）；提交 `722c1cd3392cb4cdb5c8b051f3354c8e3905e355` 及未提交工作区
- 核对范围：最初调查只读源码、配置和迁移。2026-11-19 已运行本地 Nitro、H3 及专项测试，见[落实与验证](#落实与验证)
- 实现设计：[SID#2.5.AGENT-DESIGN](AGENT-DESIGN.md)

## 人类裁定

| 日期 | 原话或要点 | 落实 |
| --- | --- | --- |
| 2026-11-15 | “那 #2.5 就只写 AGENT-DESIGN 和 AGENT 吧” | 不设 LAW；LAW 草稿已删除 |
| 2026-11-15 | sitemap 收录范围“保持现状就好” | 继续列出全部档案和全部未封禁用户的主页，包括没填过资料的账号 |
| 2026-11-15 | 设备标识的归属“放 2.1” | 本目录不再写；结构和规则只在 [SID#2.1.AGENT-DESIGN](../1_accounts/AGENT-DESIGN.md) 写一次。httpOnly 被注释掉的问题已登记在 [SID#2.1.AGENT](../1_accounts/AGENT.md) |
| 2026-11-15 | 健康检查返回迁移数“不管了” | 保持现状：成功时返回 `{ status: 'ok', migrations: <数> }` |

没有待答复的问题。

## 分工的读法

- 本目录只写“设施对业务承诺什么”。机制在 `SID#0.1.DESIGN`，操作步骤在 `SID#1`，控制台展示在 `SID#2.3`，各类通知和扫描的业务内容在所属目录。AGENT-DESIGN 的资源清单和扫描清单只做索引。
- `content_sync_outbox` 归 `4_content`，但投递规则只有一份，写在本目录。
- 存储审计的表归本目录。它是唯一一个不属于任何业务、却登记在“档案”扫描清单里的扫描，见下面『其他出入』。
- 对象退役与存储审计分别记录在线使用的迁移明细表，五张表的归档和退役由 `SID#1.4` 维护。

## 代码与总体文档的出入

| 出入 | 现状 | 建议 |
| --- | --- | --- |
| `SID#0.1.DESIGN` 说后台状态“不得包含云服务错误信息” | 相符：错误代码经正则过滤，只放行固定代码 | 无需处理 |
| `SID#0.1.DESIGN` 的通知图只画了 outbox 和 `publish_refresh()` 两条路 | 相符 | 无需处理 |
| `SID#0.1.DESIGN` 说扫描“在所属业务的 services 中实现” | 存储审计在 `server/services/storage-audit/`，不属于任何业务 | 见下面『其他出入』第 1 条 |

## 其他出入

1. **扫描清单挂在档案名下。** 清单、runner 的创建和登记函数都在 `server/services/content/background.service.ts`，名字也叫 `content_background_*`，但其中的 `storage_audit` 不是档案业务。`background/status.service.ts` 反过来依赖它取周期。可以把清单移到 `server/services/background/`，档案只提供自己的几项。这是重构，没有动。
2. **请求错误曾重复记日志。** 2026-11-19 在 Nitro 2.13.4 的本地隔离应用中复现：同一次 418 请求在插件中记为 500，在响应处理器中记为 418。响应处理器未等 `send()` 完成，非 API 路径的纯文本还被默认处理器标成 JSON。人类已批准修复，复验见下。
3. **Redis 只在 worker 退出时断开。** 与 [SID#2.AGENT](../AGENT.md#写档案板块时要核对的线索) 的线索一致：没有业务读写。
4. **`publish_refresh()` 的通知可能丢。** 断线队列只在内存里、上限 100 条。这是 `SID#0.1.DESIGN` 已接受的取舍，靠前端的失效机制兜底，这里只记录。

## 待办

| 事项 | 完成条件 |
| --- | --- |
| 补三处没有测试的验收条目 | 已完成，sitemap 与 robots、设备身份 cookie、错误响应均已在[验收表](AGENT-DESIGN.md#验收标准)列出 |
| 迁移明细表的结构说明 | 已完成，[存储审计](AGENT-DESIGN.md#存储审计)和[对象退役](../4_content/7_storage/AGENT-DESIGN.md#删除流程)均已指向维护流程 |

## 落实与验证

- 2026-11-26 在 Chrome DevTools 的隔离标签页打开 `https://localhost:3042/content/1`，只中断公开 MQTT WebSocket。短断线约 0.90 秒后重连，收到订阅确认且没有 Toast。持续断线约 5.04 秒时提示一次，重连间隔实测约 0.85、1.73、3.64、7.29、14.78 秒。恢复后再次断线，约 0.88 秒后重连，收到订阅确认后正文补读返回 200。30 秒上限由[传输测试](../../../app/composables/useDataSync.test.ts)覆盖。
- 2026-11-19 以 `node .dev/handoff-error-check/run.mjs` 构建临时 Nitro 应用，加载项目的插件与错误处理器，用 `localFetch` 各触发一次 `/api/sample` 和 `/sample`。修复后每个请求只有一条 418 日志，前者为 JSON，后者为 `text/plain`。
- `pnpm exec vitest run server/error-handler.test.ts server/errors/public-message.test.ts` 两文件 8 项通过。H3 内存请求覆盖业务异常、校验失败和其他 HTTP 错误，检查日志、响应体、状态码和实际响应头。
- `pnpm exec vitest run server/api/hooks/sitemap/urls.get.test.ts server/services/profile.service.test.ts scripts/verify/nuxt-config.test.ts server/middleware/identity.test.ts` 四文件 26 项通过，覆盖 sitemap 收录与排除、robots 规则、首次签发及复用设备 cookie。
- 已核对五张迁移明细表的[用途与退出条件](../../1_workflows/4_maintain/AGENT-DESIGN.md#迁移明细归档与退役)，存储审计和对象退役的说明都已指向此节。

## 传统与工作经验

- outbox 一次只领一条、领到就发。批量领会让后面的行白白等租约过期。
- broker 断线时 outbox 一失败就结束本轮，避免一轮把所有行的重试次数都耗掉、退避被拉长。
- 存储审计不按“本轮列举没看到”批量解决发现，因为分页列举会漏看翻页期间的变化，改为逐条复查。
- runner 在扫描真正结束前不释放资源名额，即使关闭已超时。否则会掩盖还在跑的外部操作。
- 敏感资源的频道名由服务端下发，浏览器不自己算，因为 HMAC 密钥不能进前端。

## 旧资料去向

2026-11-19 核对 `docs-legacy/modules/` 下的两份手册。`docs-legacy/operations/storage-audit.md` 的操作部分早先已归 `SID#1.4`，没有在本轮逐条核对。

| 来源 | 去向 |
| --- | --- |
| 旧后台手册（`docs-legacy/modules/background-jobs.md`）『当前负责的工作』 | AGENT-DESIGN『扫描清单』『存储审计』；引用历史 200 批归 `SID#2.4.3` |
| 旧后台手册『运行模式』『调度和退出』 | 概念在 `SID#0.1.DESIGN`『后台任务』；生产模式和切换操作归 `SID#1.4`。排队、唤醒合并和两条唤醒接线在 AGENT-DESIGN『扫描清单』 |
| 旧后台手册『状态与排障』 | AGENT-DESIGN『后台状态』，控制台展示归 `SID#2.3`；观测项里的 `db_acquire` 以 [upload-observation.ts](../../../server/lib/upload-observation.ts) 为准 |
| 旧后台手册『账本保留与压缩』 | 回执压缩归 `SID#2.4.7`『各后台任务』；2026-11-01 的 EXPLAIN 和计数是历史快照 |
| 旧同步手册（`docs-legacy/modules/realtime.md`）『同步链路』『两类发布方式』 | AGENT-DESIGN『通知送达』和 `SID#0.1.DESIGN`『数据更新』。HMAC 换钥、私有凭据 30 秒、前端连接和订阅确认的细节都在『通知送达』。已过时：“双权限校验”，现为草稿 `content_access:full` 加有效会话 |
| 两份手册的『源码与验证』 | `SID#1.2` |
