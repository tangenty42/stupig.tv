# 草稿、引用基线与同步保护

正文草稿、服务端正文、附件工作区和上传会话各有独立生命周期。上传成功不会直接替代整篇本地草稿；附件路径变化通过引用历史精确作用于草稿。

## 草稿状态

`contentDraft` Pinia store 保存可序列化的未保存 Markdown、正文基线与引用基线，并按配置写入 localStorage。它不持有 MQTT 连接，也不保存待上传 `File`；文件句柄属于上传恢复机制。

编辑页加载时比较草稿与当前服务端状态，决定恢复、提示冲突或舍弃。切换档案、登录身份和销毁页面会使旧异步结果失效；不能让上一页的请求回调覆盖当前文稿。舍弃草稿时同时更新正文和引用基线。

## 三类版本

| 基线 | 解决的问题 |
| --- | --- |
| 正文 revision | 检查另一位编辑者是否已保存正文 |
| namespace revision | 判断附件／目录路径在草稿产生后如何变化 |
| title revision | 判断被引用档案的标题如何变化 |

服务端引用历史记录对象身份及路径／标题变化。保存、重放都从提交基线推导变化，而不是用当前同名路径猜测原目标。

当历史基线未知、过期或跨越迁移设定的 floor 时，系统不能证明旧引用仍指向原对象，需要用户审查。原目标删除后，同一路径出现新附件也不能静默视作同一对象。`replaced` 与 `missing` 诊断分开处理，仍缺失目标时不能靠推进总体基线跳过保护。

## 异步重放

`create_draft_reference_bridge()` 串行请求重放，并在请求前记录档案、访问者、Markdown、本地版本和各引用基线。结果只在完整快照仍匹配时应用；期间状态变了，就丢弃旧结果并按最新状态重新处理。

编辑器通过 `apply_reference_changes(snapshot, changes)` 应用目标补丁，保留其他正文和编辑历史。没有变化的目标不顺手格式化。引用语法和忽略区域与[Markdown 解析](markdown.md)共用。

## 慢网速下的编辑保护

正文只读状态覆盖服务端正文同步、引用重放请求以及上传末期的引用同步衔接。上传运行时从 seal／图片处理／adopt 观察到 finalizing，接受工作区和调用落地回调时继续保持保护，再交给正文引用同步。

这段保护针对『上传已成功，但正文替换尚未完成』的空窗期：不能提前解锁让用户输入，再用旧请求结果覆盖新内容。它不要求整段上传期间禁用所有附件操作。

只读同时设置 CodeMirror `EditorState.readOnly` 和 `EditorView.editable`，并由插入等操作入口遵守；保存也检查待同步状态。单纯把保存按钮变灰不能保证正文没有被键盘、粘贴或程序插入改变。

## 引用历史维护

引用历史有保留期限和 floor；清理不能把无法重放的草稿伪装成已同步。`server/plugins/reference-journals.ts` 当前使用独立 Nitro 定时维护，不属于五类后台 runner 适配器。切换 runner 为 worker／disabled 并不会自动迁移或关闭这项维护。

## 源码与验证

- 草稿：[`contentDraft.ts`](../../../app/stores/contentDraft.ts)。
- 页面生命周期：[`useStoryEditSession.ts`](../../../app/composables/useStoryEditSession.ts)。
- 重放协调：[`draft-reference-bridge.ts`](../../../app/utils/content/draft-reference-bridge.ts)。
- 编辑器只读及补丁：[`useStoryEditor.ts`](../../../app/composables/useStoryEditor.ts)。
- 服务端历史：[`reference-history.service.ts`](../../../server/services/content/reference-history.service.ts)。

自动测试重点包括迟到结果、原文快照不符、跨身份／档案、未知基线、删除后重建、上传末期保护。浏览器验收使用双页草稿、改名／移动／替换和慢网速，核对未涉及的正文保持不变，引用同步结束后恢复输入。
