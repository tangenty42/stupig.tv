# AGENT：领域文档进度与调研记录

- 本文档状态：PENDING（各目录的 LAW 和配套文档都已写完；剩下的是浏览器验收和下文待办）
- 覆盖范围：`docs/2_domains/` 的编写进度、本轮调研的方法与范围、调研中发现的重要问题
- 旧文档：`docs-legacy/` 已于 2026-11-19 删除；本文提到的旧手册、旧台账以及“留在原文”的内容，原文都在 git tag `docs-legacy-final`
- 核对基线：2026-11-12 00:30:08 +08:00（Asia/Shanghai）；提交 `722c1cd3392cb4cdb5c8b051f3354c8e3905e355` 及未提交工作区（78 个改动文件）
- 依据：[SID#README](../README.md)、[SID#0.1.LAW](../0_overall/1_architecture/LAW.md)、人类在 2026-11-11 至 11-12 的指示
- 安全修复：2026-11-12 01:08:31 +08:00（Asia/Shanghai）起，按人类授权修复用户筛选和头像大小限制；回归使用真实路由与服务，数据库、存储和认证边界使用替身
- 账号 LAW 落实：2026-11-12 14:37:08 +08:00（Asia/Shanghai）起，按 SID#2.1.LAW 和人类答复改了权限模型等，验证范围见 [SID#2.1.AGENT](1_accounts/AGENT.md#本轮验证)
- 组织方式：[SID#2.AGENT-DESIGN](AGENT-DESIGN.md)

## 人类的指示

- 权威文档只写 LAW：可观测行为清单和验收标准，尽量短。Agent 提供草稿，人类参考后自己写正式版。
- 非权威文档写 AGENT-DESIGN 和 AGENT。AGENT-DESIGN 至少写大体的实现设计和数据库结构，AGENT 写传统和工作经验。
- 不参考本目录下的两份 TMP 调查材料，它们有不少内容已过时。以源码为准。2026-11-19 各目录写完后，人类决定删除这两份材料。
- 蠢猪档案拆九个子目录；LAW 草稿放各目录的 `TMP-LAW.md`；先写账号与权限作样板，人类看过再铺开。
- 2026-11-12 补充：LAW 只讲业务和界面上看得到的行为，用大白话写，不带技术用语；验收标准下放给 AGENT-DESIGN 或 AGENT，这两份文档按现有逻辑补写，用来约束具体实现，也有规范效力、不轻易改。上面第一条里“LAW 写验收标准”的说法以本条为准。
- 2026-11-12 再补充：人类写了 [账号与权限的 LAW](1_accounts/LAW.md)，并说 LAW 就保持这样的详略；LAW 没提的具体细节和规定下放到非权威文档。后续目录的 LAW 以它为样子。
- 2026-11-12 傍晚：人类写了 [平凡页面的 LAW](2_pages/LAW.md)，比草稿短得多，每页一句话，并要求其他文档向它对齐。由此可知 LAW 可以短到只交代“这里有什么”，页面上的具体文案和『整活』不进 LAW。
- 2026-11-12 晚：人类写了 [管理控制台的 LAW](3_admin/LAW.md)，并批准把后台任务状态和存储审计结果做进控制台，归管理控制台板块；要求先调查和计划，界面要和现有的风格融合。人类看过计划并答复后已实现，经过见 [SID#2.3.AGENT](3_admin/AGENT.md#人类裁定)。
- 2026-11-19：`docs-legacy/modules/` 下 12 份手册由三个子代理（按人类点名使用 Kimi K3.1 Pro）逐章对照新文档和源码，主代理抽查后写进各目录 AGENT 的『旧资料去向』。仍成立但没写进 AGENT-DESIGN 的实现细节标为“以源码为准”。

## 进度

| 目录 | LAW | AGENT-DESIGN | AGENT | 调研 |
| --- | --- | --- | --- | --- |
| `1_accounts` | [人类已写](1_accounts/LAW.md)，状态 DONE | [已写](1_accounts/AGENT-DESIGN.md) | [已写](1_accounts/AGENT.md)，含裁定和落实记录 | 主代理逐行读过 |
| `3_admin` | [已定稿](3_admin/LAW.md)，入口为『用户』和『运行状态』 | [已写](3_admin/AGENT-DESIGN.md)，含用户与运行状态两个视图 | [已写](3_admin/AGENT.md) | 运行状态合并后台任务和存储审计，验证结果归该领域记录 |
| `2_pages` | [人类已写](2_pages/LAW.md)，状态 PENDING；待定事项都已答复 | [已写](2_pages/AGENT-DESIGN.md) | [已写](2_pages/AGENT.md) | 主代理读过两个页面及相关代码；验收测试已补，浏览器测试由人类跑通 |
| `0_framework` | [人类已写](0_framework/LAW.md)，状态 DONE；待定事项都已答复 | [已写](0_framework/AGENT-DESIGN.md) | [已写](0_framework/AGENT.md) | 主代理读过 `app.vue`、提示、确认、时区、明暗模式、请求与 401 处理；`useDataSync` 只读了部分。删除确认框的快照说明有组件测试 |
| `5_operations` | 不设（人类 2026-11-15 答复） | [已写](5_operations/AGENT-DESIGN.md) | [已写](5_operations/AGENT.md) | 运行维护的本地 Nitro 复验及 sitemap、robots、设备 cookie、错误输出测试见[落实与验证](5_operations/AGENT.md#落实与验证) |
| `4_content` | [人类已写](4_content/LAW.md)，Agent 审查通过 | [已写](4_content/AGENT-DESIGN.md) | [已写](4_content/AGENT.md) | 主代理读过路由、权限判定、机密解析、列表与正文、附件目录、下载签名 |
| `4_content/0_stories` | [人类已写](4_content/0_stories/LAW.md)，状态 DONE | [已写](4_content/0_stories/AGENT-DESIGN.md) | [已写](4_content/0_stories/AGENT.md) | 主代理读过列表页、详情页、卡片、日历、`stories.ts`、`story.service.ts` 的列表与正文 |
| `4_content/1_drafts` | [人类已写](4_content/1_drafts/LAW.md)，状态 DONE | [已写](4_content/1_drafts/AGENT-DESIGN.md) | [已写](4_content/1_drafts/AGENT.md) | 主代理读过草稿服务、权限、编辑页、store 的部分、草稿列表、建表语句；恢复区改成对话框，人类已截图确认 |
| `4_content/2_markdown` | [人类已写](4_content/2_markdown/LAW.md)，状态 DONE | [已写](4_content/2_markdown/AGENT-DESIGN.md) | [已写](4_content/2_markdown/AGENT.md) | 主代理读过渲染器、白名单、机密、占位；统一占位已改代码，单元测试通过 |
| `4_content/3_references` | [人类已写](4_content/3_references/LAW.md)，状态 DONE | [已写](4_content/3_references/AGENT-DESIGN.md) | [已写](4_content/3_references/AGENT.md) | 主代理读过引用解析、引用历史、删除影响；旧写法已删，单元测试通过 |
| `4_content/4_attachments` | [人类已写](4_content/4_attachments/LAW.md)，状态 DONE | [已写](4_content/4_attachments/AGENT-DESIGN.md) | [已写](4_content/4_attachments/AGENT.md) | 子代理调研、主代理核对；文件夹上传冲突等已改代码，测试通过 |
| `4_content/5_images` | [人类已写](4_content/5_images/LAW.md)，状态 DONE | [已写](4_content/5_images/AGENT-DESIGN.md) | [已写](4_content/5_images/AGENT.md) | 主代理逐条核对源码和配置；删了加密残留和死配置，HEIC 纳入处理 |
| `4_content/6_access` | [人类已写](4_content/6_access/LAW.md)，状态 DONE | [已写](4_content/6_access/AGENT-DESIGN.md) | [已写](4_content/6_access/AGENT.md) | 主代理读过固定链接、签名、边缘函数、鉴权回调、下载；按裁定改了固定链接的检查顺序和占位文字，单元测试通过 |
| `4_content/7_storage` | [人类已写](4_content/7_storage/LAW.md)，状态 DONE | [已写](4_content/7_storage/AGENT-DESIGN.md) | [已写](4_content/7_storage/AGENT.md) | 主代理读过对象退役、上传收尾、预热、回执压缩、孤儿清理和相关配置 |

## 本轮调研

没有启动应用、运行测试或连接任何设施，全部结论来自读源码、配置、迁移和测试文件。没有读取 `.env*`。

账号、控制台、平凡页面和公共框架由主代理直接读。蠢猪档案和运行维护设施的源码量大，分给五个子代理（按人类点名使用 Kimi K3）各出一份报告，主代理抽查后更正了六处错误。

报告原文和勘误保存在本机的 `.dev/domain-research-2026-11-11/`，该目录被 Git 忽略，换一台机器就没有了。写某个目录前先看勘误 `research-corrections.md`，报告里的说法要回到源码核对后再写进文档。

已更正的六处：

| 报告里的说法 | 实际 |
| --- | --- |
| 草稿编辑权的租约 18 秒 | 23 秒 |
| `content_stories.related_story_ids` 是没人用的列 | 该列已被迁移删除 |
| 标题上限 60 字符 | 60 字节 |
| 图片上限宽高 8192、4000 万像素 | 宽高 4096、总像素 9,437,184、20 MiB |
| 附件读取只有内联展示，没有下载 | 页面内读取是内联；下载走另一个接口，有效期 300 秒 |
| 下载有效期的配置没找到使用处 | 就是上一行的下载接口 |

## 调研发现的重要问题

这些会影响 LAW 怎么写，或者本身需要处理。原调查只读源码；用户筛选和头像大小限制已在下面记录修复与回归范围。

### 控制台的用户筛选把输入直接拼进 SQL

原实现把筛选字符串直接拼进 SQL，只读账号可以通过子查询及返回行数推断隐藏数据。修复前的真实路由回归已确认不安全条件会进入数据库调用；验证使用数据库替身，没有查询实际账号数据。

按人类授权保留 SQL 样式的筛选输入，由 [服务端筛选编译器](../../server/services/admin-filter.ts) 解析为受限表达式，再将值绑定为参数。仅接受允许字段的比较、AND／OR／NOT、IN、BETWEEN、IS 和排序；子查询、其他函数、UNION、额外语句、锁及输出文件等在数据库调用前拒绝。排序与计数分开，输入长度及表达式复杂度有界。

筛选字段与查看权限一致。修复时只读账号不能按手机号筛选或排序；SID#2.1.LAW 定下『控制台·只读』可以看手机号之后，凡是能进控制台的人都能按手机号筛选。密码和令牌哈希对所有角色都不开放。字段提示也按同一权限生成。[路由回归](../../server/trpc/routers/admin.test.ts)覆盖绕过浏览器校验、隐藏字段、参数绑定和权限；[编译器测试](../../server/services/admin-filter.test.ts)覆盖合法语法、字符串转义及拒绝范围。旧账号手册所说的服务端白名单校验现已落实。

### 头像大小上限（已修复）

见 [账号与权限的人类裁定](1_accounts/AGENT.md#人类裁定)第 1 项。

### 权限的授予

`SID#0.0.LAW` 规定档案权限只能赋予六名成员且由人类亲自操作。人类的裁定是网站不管这件事，由管理员自己把握；同时 SID#2.1.LAW 把『控制台·完全』定为管理员特有，所以现在只有管理员能授权。见 [账号与权限的人类裁定](1_accounts/AGENT.md#人类裁定)第 2、3 项。

### 写档案板块时要核对的线索

以下线索来自早期调查，2026-11-19 核对了剩余四项。

| 线索 | 状态 |
| --- | --- |
| `content.createStory`、`updateStory`、`deleteStory` 三个接口保留着，但只会返回 409，提示刷新页面使用云端草稿 | 已核对 |
| 编辑页有一个“标签页锁不可用”的红色告警分支，对应的变量恒为假 | 已核对，批次 9 已清理 |
| Redis 客户端没有任何业务读写，只有独立 worker 退出时断开连接 | 已核对 |
| sitemap 列出全部档案和全部未封禁账号的主页 | 已核对 |
| 草稿和一切附件操作要求『蠢猪档案·完全』（原先是档案管理和机密读取两项权限，2026-11-12 按 SID#2.1.LAW 合并）；附件服务里“涉及机密再查机密权限”的参数还在，但已不改变结果 | 已核对 |
| 草稿是否会自动清理 | 已核对。[草稿服务](../../server/services/content/draft.service.ts)在发布或重置后保留已绑定草稿，列表只选未绑定或有未发布改动的行。没有按年龄清理的任务。舍弃未发布草稿会删行，删除档案则由外键级联删除草稿 |
| `.good` 表示机密，对象在存储上不加密 | 已核对。2026-11-16 删除旧 `encryption_key` 列，2026-11-19 将现行附件路径、类型、补全和渲染样式的命名统一为 `private` |
| 上传会话是否写入 `failed` | 已核对。`content_transfer_sessions` 的上传写入路径没有设置这个值；[上传收尾](../../server/services/content/upload-lifecycle.service.ts)仍能清理已有的 `failed` 行。图片任务另有自己的失败状态 |
| ESA 边缘函数的调试追踪 | 已按人类要求从[边缘函数](../../config/esa/content-auth.mjs)移除。[ESA 测试](../../server/lib/esa.test.ts)验证旧探针路径上的请求放行和拒绝时都不再输出排障日志 |
| 引用历史的保留与连续性 | 已核对。[批次数配置](../../config/app-settings.yaml)为每个范围 200 批。[引用历史仓储](../../server/services/content/reference-journal.repository.ts)截断早期批次并抬高下限，读取时只有附件范围校验逐批连续 |

## 待办

| 事项 | 完成条件 |
| --- | --- |
| 写其余目录 | 已完成，六个一级目录及档案八个子目录的文档入口见[进度](#进度) |
| 机密命名改为 private | 已完成，见下节。深浅主题的目视验收留在各子目录 |
| 清理照抄提示文字的测试 | 已完成，覆盖控制台、附件、删除确认和表单等组件。界面提示优先按触发条件、数据、控件状态和事件验证 |

## 落实与验证

- 2026-11-19 对照草稿服务、上传会话写入与收尾、ESA 边缘函数及引用历史仓储核对了上表四条线索。
- `.good` 文件名和已有操作回执的字段保持兼容。机密图片使用 `private-image-block`，与正文 `<good>` 的 `private-block` 各有样式。`pnpm exec vitest run --maxWorkers=2` 定向运行附件管理、Markdown 编辑与渲染、上传及服务端工作区测试，34 文件 718 项通过。另跑 `workspace.repository.test.ts` 和 `view-state.test.ts`，8 项通过。
- `pnpm exec vitest run --config vitest.component.config.ts` 全量组件测试 20 文件 97 项通过。`pnpm exec playwright test --config tests/css.config.ts` 独立 CSS 测试 11 项通过。生产构建 CSS 用例启动隔离库时，沙箱连接 `127.0.0.1:3306` 被拒，尚待复验。

## 工作经验

- 子代理的报告信息量大，但数值和“没人用”这类结论容易错。六处更正里有四处是数值，一处把已删除的列说成废弃列。凡是要写进文档的数值，都回到配置文件或源码核对。
- 让子代理“每条事实附源码路径”很有用，抽查时能直接定位。
- 旧手册可以当线索，不能当依据。初次调查发现旧账号手册对用户筛选的描述与源码相反，本次修复已补上服务端校验。
- 安全边界同时覆盖真实路由和服务。头像原服务测试自行传入正确上限，漏掉了路由读旧字段；本次已补上超限拒绝和恰好达到上限时的路由回归。
- 2026-11-16 写 `5_images`、`6_access`、`7_storage` 的 TMP-LAW 时读错多处：把从未写入的列当成功能，照生产不走的本地图片处理写了限制，漏了已有的下载、删减版标签、ESA 有效期上限和 OSS 生命周期规则。原因是没逐条核对子代理报告，加上死代码、误导的命名，以及行为写在配置和云端设置里。源码对照表因此加了“配置与云端”列；写 TMP-LAW 前每条结论都回到源码、配置和 `SID#1.0` 核对。
