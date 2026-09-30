# 架构风险与优化空间

本文记录项目当前架构中的主要风险、技术难点和后续优化方向。风险按影响和实施优先级排序，建议结合实际流量、对象数量和部署方式逐步推进。

## 总体判断

项目是一个以 Nuxt 为核心的模块化单体应用，包含社区身份、权限、内容 CMS、Markdown 编辑器、附件管理、对象存储、附件加密和实时同步。

当前架构的优点是边界清晰、业务建模充分、前后端类型共享完整，并且处理了 SSR、并发登录、跨标签页同步和附件操作冲突等真实场景。主要风险集中在跨系统一致性、实时事件可靠性、全局状态复杂度和部分服务体量过大。

## 主要风险

### 1. OSS 与数据库之间缺少原子一致性

附件和头像分别由 MySQL 元数据与 OSS 对象共同组成，两个系统之间没有分布式事务。当前删除流程通常是：

1. 删除或更新数据库记录；
2. 删除 OSS 对象。

因此可能出现：

- 数据库有记录，但 OSS 对象不存在；
- 数据库记录已经删除，但 OSS 对象删除失败；
- 上传临时对象、复制对象或 multipart upload 在中途失败后遗留；
- 旧头像替换成功，但旧对象未能删除。

相关代码：

- [server/services/content.service.ts](../server/services/content.service.ts)
- [server/services/profile.service.ts](../server/services/profile.service.ts)
- [server/lib/storage.ts](../server/lib/storage.ts)

当前已有 [scripts/cleanup-orphan-attachments.ts](../scripts/cleanup-orphan-attachments.ts) 对账工具，默认只报告，`--delete` 才执行清理。它覆盖正式附件、历史数据库 orphan 行、临时上传、multipart upload 和未引用头像。

**建议：**

- 保留定期 reconciliation job，先 report-only，再自动删除；
- 为 OSS 删除增加重试记录，不要静默吞掉所有异常；
- 长期增加 `storage_delete_jobs` 或 outbox 表；
- 对数据库有引用但 OSS 缺失的对象只告警，不自动删除数据库记录；
- 为临时上传和 multipart upload 设置明确的保留期限。

优先级：**高**。

### 2. MQTT 刷新事件可能丢失

实时同步通过 MQTT 发布资源刷新事件，客户端收到事件后重新请求数据。当前 MQTT 发布逻辑在连接未就绪时有限重试，最终仍可能丢弃事件。

相关代码：

- [server/lib/mqtt.ts](../server/lib/mqtt.ts)
- [server/lib/sync.ts](../server/lib/sync.ts)
- [app/composables/useDataSync.ts](../app/composables/useDataSync.ts)
- [app/composables/useSyncedData.ts](../app/composables/useSyncedData.ts)

事件本身只表示“资源需要刷新”，不保存完整状态。因此事件丢失后，客户端可能长时间看不到最新数据，除非存在轮询或重新进入页面。

**建议：**

- 把 MQTT 定位为低延迟通知，而不是可靠消息队列；
- 对关键资源保留 `updated_at`、revision 或版本号校验；
- 客户端重连后主动刷新已订阅资源；
- 需要严格可靠时，增加数据库 outbox：业务事务写数据时同时写事件，后台任务负责发布；
- 记录发布失败次数和资源标识，便于定位同步问题。

优先级：**高**。

### 3. OSS 删除失败被静默忽略

多个业务路径使用 `.catch(() => {})` 忽略 OSS 删除异常。这能避免外部存储故障阻塞用户操作，但会隐藏真正的一致性问题。

**建议：**

至少记录结构化日志：

```ts
try {
  await delete_object(key)
}
catch (error) {
  console.error('[storage-delete-failed]', { key, error })
}
```

更好的方案是：数据库事务只记录待删除对象，后台任务异步删除并重试。

**现状（已实施最低方案）：** 所有业务删除统一走 [server/lib/storage.ts](../server/lib/storage.ts) 的 `delete_object_best_effort()`，失败时输出 `console.error('[storage-delete-failed]', { key, error })`，业务路径不再静默吞错；数据库待删除记录 + 后台重试仍未做。新代码禁止再写 `delete_object(...).catch(() => {})`。

优先级：**高**。

### 4. 内容服务职责过多

[server/services/content.service.ts](../server/services/content.service.ts) 同时处理：

- Story 创建、更新、删除；
- Markdown 校验和引用解析；
- 附件上传、替换、重命名和移动；
- 文件夹操作；
- 附件加密和解密；
- OSS 对象复制和删除；
- 内容同步事件。

目前逻辑仍可维护，但继续加功能会使测试、依赖关系和事务边界越来越难理解。

**建议：**

渐进拆分为以下领域服务：

- `content-story.service.ts`
- `content-upload.service.ts`
- `content-folder.service.ts`
- `content-encryption.service.ts`
- `content-rendering.service.ts`

拆分时保持现有 tRPC API 不变，先移动内部函数和测试，再调整 import，避免一次性大重构。

优先级：**中**。

### 5. 实时同步依赖较多模块级全局状态

[app/composables/useDataSync.ts](../app/composables/useDataSync.ts) 管理 MQTT client、BroadcastChannel、连接 generation、listener map、客户端 ID 和连接状态；[app/composables/useSyncedData.ts](../app/composables/useSyncedData.ts) 又管理共享代理、请求合并和轮询。

这套设计解决了前台标签页、后台标签页、SSR 和 hydration 等问题，但也增加了：

- 测试隔离难度；
- 热更新和页面卸载时的状态残留风险；
- 并发连接切换时的控制流复杂度；
- 新开发者理解成本。

**建议：**

逐步抽象一个明确的 `SyncRuntime`，集中管理：

- `start()` / `stop()`；
- `subscribe()` / `unsubscribe()`；
- `publishLocal()`；
- 连接状态；
- 生命周期清理。

保持 `useDataSync` 作为 Vue 适配层，不让业务页面直接依赖底层 MQTT 细节。

优先级：**中**。

### 6. 生产错误响应可能泄露内部信息

[server/error-handler.ts](../server/error-handler.ts) 对一般 `Error` 会直接使用 `error.message` 返回给客户端。某些数据库、OSS 或第三方 SDK 异常可能包含内部路径、SQL 片段、服务地址或实现细节。

**建议：**

- 生产环境仅向客户端返回通用错误消息；
- `ApiError` 和校验错误才返回明确的用户提示；
- 服务端日志保存完整 stack；
- 给响应增加 request ID，方便从日志定位；
- 区分可预期业务错误、外部服务错误和内部错误。

优先级：**高**。

### 7. 批量操作的规则在客户端和服务端之间重复

附件批量加密、移动和删除会在客户端提前拆分可操作项，服务端仍会对整个请求执行最终校验。这种设计提升了交互体验，但客户端规则和服务端规则可能逐渐漂移。

**建议：**

服务端返回结构化部分成功结果，例如：

```json
{
  "succeeded": ["a.png"],
  "skipped": [
    { "file_name": "secret.png.good", "reason": "encrypted" }
  ]
}
```

客户端可以继续提前预览，但服务端结果应当是最终权威。

优先级：**中**。

**现状（已实施）：** 批量加密、移动和删除现在由服务端返回 `succeeded` 与带原因的 `skipped`，客户端仍可提前拆分以改善交互，但只按服务端结果更新本地 markdown 和附件列表；服务端结果是最终权威。

### 8. 数据库迁移流程仍可加强

项目有独立的 `migrations/` 目录和参考 schema，但随着 Session generation、附件加密、文件夹行等结构持续演进，手工执行迁移的风险会增加。

**建议：**

- 增加迁移版本记录表；
- 明确迁移命名和执行顺序；
- 部署时自动检查待执行迁移；
- 对不可逆迁移记录明确说明；
- 在 CI 中用全新数据库执行完整迁移；
- 保持 [stupig_tv.sql](../stupig_tv.sql) 作为参考 schema，不直接修改其职责。

优先级：**中**。

### 9. 生产可观测性不足

当前主要依赖 `console` 日志，难以完整回答以下问题：

- 哪次上传卡住或失败；
- 哪个请求触发了锁竞争；
- 某个同步事件是否发布失败；
- 某个 Session 为什么被判定为无效；
- OSS 与数据库何时开始不一致。

**建议：**

统一结构化日志字段：

- request ID；
- user ID / session ID；
- story ID；
- operation kind；
- duration；
- 外部服务名称和结果；
- 错误分类。

同时为 OSS 对账、MQTT 发布、附件锁竞争和登录失败增加计数指标。

优先级：**中**。

## 技术难点与维护重点

### Session token generation family

[server/services/session.service.ts](../server/services/session.service.ts) 没有简单地让 JWT 失效，而是将 token hash 按 generation 保存到数据库，并允许旧 generation 在自身过期前继续完成并发请求。这解决了 SSR、多个标签页和 Set-Cookie 丢失造成的随机登出问题。

后续修改认证逻辑时必须重点回归：

- 并发刷新；
- 旧 generation 请求；
- Session logout；
- ban 用户；
- SSR 请求不得轮换 token；
- generation 数量上限。

### 附件路径和加密状态

附件名称、扩展名、`.good` 标记和数据库中的 `encryption_key` 共同决定渲染状态。文件重命名不能改变加密状态，替换加密文件也必须被拒绝。

相关共享规则位于 [server/shared/content-markdown.ts](../server/shared/content-markdown.ts)，不要在页面、router 和 service 中分别重新实现文件名规则。

### Markdown 编辑器与预览的一致性

编辑器、预览和服务端保存使用共享 Markdown 规则，但 CodeMirror 语言解析、lint、补全、源代码行锚点和 HTML 嵌套解析仍然是多个独立实现面。

新增 Markdown 语法时应同时考虑：

- 服务端解析和保存校验；
- 编辑器高亮和补全；
- 预览渲染；
- SSR 输出；
- 图标 bundle 注册；
- 对应测试 fixture。

## 优先级路线图

### 高优先级

1. 保持 OSS 对账任务定期运行，先报告再自动删除；
2. 为 OSS 删除失败增加重试或删除任务表；
3. 对生产错误响应做脱敏；
4. 为 MQTT 事件增加重连刷新和版本校验；
5. 为上传、删除、加密和目录移动增加故障注入测试。

### 中优先级

1. 拆分 `content.service.ts`；
2. 抽象 `SyncRuntime`；
3. 建立正式数据库迁移执行记录；
4. 增加结构化日志、request ID 和关键指标；
5. 让批量操作返回结构化部分成功结果。

### 低优先级

1. 清理历史兼容代码；
2. 统一少量命名和注释风格；
3. 为拖拽、IndexedDB、Canvas、MQTT 浏览器行为增加端到端测试；
4. 继续优化前端同步代理的测试工具。

## 验证基线

当前项目已有较完整的单元测试，最近验证结果为：

- 19 个测试文件；
- 436 个测试通过；
- `npx nuxt typecheck` 通过；
- `pnpm lint` 通过。

后续每次处理上述风险时，应至少补充对应领域的回归测试，并优先验证失败路径，而不是只验证正常流程。
