# AGENT：前端业务模块重构实施

- 基线：后续文档与测试边界静态核对时间 2026-11-05 22:00:43 +08:00（Asia/Shanghai）；代码提交 `67f8dad0a15c76acdb079c1334b143fcc146b935` 及当前未提交工作区；Content 工具整理独立复验结论沿用 21:11:28 +08:00，三阶段重构补验结论沿用 17:09:22 +08:00
- 任务状态：DONE（三阶段业务模块重构及后续 Content 工具归属整理均已完成代码验收；两项非阻塞建议已落实，剩余测试与权威 DESIGN 事项另列，等待人类审核后再执行）
- 覆盖范围：前端业务模块归属、content 页面入口、账号身份与个人资料页面重构
- 复杂依赖：[SID#0.1.LAW](LAW.md) 规定总体板块职责，[SID#0.1.DESIGN](DESIGN.md) 规定总体实现结构；本记录依据人类明确批准的分阶段重构方案说明当前实现与尚未回填的偏差

## 引经据典

- [SID#README](../../README.md)：权威文档由人类维护，Agent 仅更新 AGENT、TMP 及工程协作规则。
- [SID#0.1.LAW](LAW.md)：账号与权限、蠢猪档案和公共框架是不同功能板块；登录注册业务不应由公共框架承担。
- [SID#0.1.DESIGN](DESIGN.md)：现行总体设计已补入 features 及页面、组件、公共 composables、utils 的职责，并移除固定 `app/stores/` 条目；状态生命周期、前后端协作、身份、数据更新及 SSR 规则仍待人类补充。
- [SID#0.1.TMP-GOOD-REFACTOR](TMP-GOOD-REFACTOR.md)：人类核对的三阶段迁移范围、实施结果和第三阶段验收重点。
- [SID#0.1.TMP-GOOD-DESIGN](TMP-GOOD-DESIGN.md)：供人类后续更新总体 DESIGN 时参考的通用模块候选正文。
- [SID#0.1.TMP-CONTENT-UTILS-REFACTOR](TMP-CONTENT-UTILS-REFACTOR.md)：后续 Content 工具归属整理的范围、实施结果、暂缓项和独立验收记录。

## 目前实现

| 引经据典 | 实现产物 | 现状 |
| --- | --- | --- |
| 人类批准的第一阶段 | `app/features/content/`、`app/components/MyContent/*/internal` 及邻近实现 | 草稿、上传、附件和组件内部逻辑已按归属迁移；Nuxt 组件发现仅包含 Vue SFC。第一阶段已通过人类补验 |
| 人类批准的 Content 工具后续整理 | `app/features/content/{attachments,uploads}/`、`app/components/MyContent/**/internal/`、`app/utils/content/` | 上传与附件业务规则、组件交互、DOM 生命周期和纯渲染能力已按实际职责拆开；`markdown/` 及人类要求暂缓的纯模块保留，旧路径无转发层，已确认的 `draft-reference-bridge.ts` 死代码已删除 |
| 人类批准的第二阶段 | `app/features/content/stories.ts`、`editing.ts` 与三个 content 页面 | 公共查询、编辑会话及上传正文回填已由业务入口负责；第二阶段已通过人类验收 |
| `SID#0.1.LAW` 的账号与公共框架边界 | `app/features/account/auth.ts`、`app/components/MyAccount/AuthDialog.vue`、`app/app.vue` | 公共框架只组合身份入口和账号组件；登录注册、验证码及 pending 状态已退出 `app.vue` |
| 人类批准的第三阶段 | `app/features/account/profile.ts`、三个 `MyAccount/Profile*` 组件及 `app/pages/u/[id].vue` | 资料、安全和会话的 API、同步与操作状态归账号 feature；路由页仅负责参数、SEO 和区块组合。结构核对与 SSR 隔离补验通过，第三阶段收尾 |
| 身份事实源与传输边界 | `app/composables/useAuth.ts`、`useTrpcClient.ts`、`app/plugins/data-sync.client.ts` | 沿用 cookie 身份，无新身份 store 或 API/auth 初始化循环；并发 401 任务按 Nuxt 应用实例隔离，同实例合并、跨 SSR 请求各自退出，完成后可再次处理 |
| 验证要求 | 账号 feature 单测、既有组件测试及账号 E2E | 本轮独立执行应用单测 60 文件、770 项，以及服务端 SSR 隔离复现 1 项，均通过；lint、Nuxt typecheck 与差异格式检查通过。组件测试 32 项和 6 个隔离浏览器场景沿用上轮证据，详细范围见 `SID#0.1.TMP-GOOD-REFACTOR` |
| Content 工具整理验收 | 应用、组件、生成清单及真实浏览器生命周期 | 独立执行应用单测 63 文件、760 项和组件测试 32 项；图片占位及 iframe／轮播各 1 个隔离 Chromium 场景通过；完整 lint、Nuxt／scripts／tests typecheck、旧路径与生成清单核对及 `git diff --check` 均通过，详见 `SID#0.1.TMP-CONTENT-UTILS-REFACTOR` |
| Content 工具整理独立复验 | 21:11:28 的迁移结果及调用边界 | 复验通过：760 项应用单测、32 项组件测试、5 个业务浏览器场景、11 个 CSS 官方 API 场景，lint、三套 typecheck、生成清单及差异格式均通过；未发现阻塞缺陷，原始记录见计划的独立复验部分 |
| 附件交互契约与选择测试后续核对 | `attachments/panel.ts`、`editing.ts`、`Workspace.nuxt.test.ts` 与 `internal/list-interaction.test.ts` | 22:00:43 静态核对确认：打开／保存能力及编辑入口的参数均已必填，生产调用均显式传入；选择、右键、点击外部、锚点重置和卸载清理已经由真实 SFC 测试覆盖，纯选择规则继续独立测试。两项原改进建议不再属于待办 |
| 后续测试改造的既有浏览器证据 | `content-reference-attachments.spec.ts`、`content-editor-view-state.spec.ts` | 21:11:28 已执行的场景分别覆盖真实页面右键重命名、删除影响，以及全屏、公开预览和视图状态恢复；后续组件测试补接线缺口，不为相同组合重复新建 E2E |
| 后续静态核对边界 | 当前工作区与测试源码 | 本次只核对实现、测试归属及文档，不重新运行应用、组件或浏览器测试；新的验收结论不得沿用为对后续改动的执行记录 |

权威文档未由 Agent 修改。核对时 [SID#README](../../README.md)、[SID#0.1.LAW](LAW.md) 与 [SID#0.1.DESIGN](DESIGN.md) 的 SHA-256 分别为 `4A477D396153B3444D4E8A4CB3E6B652711D99BB8313FF900DD817F4D06EDCDC`、`BE5140E21A2BF76E0FC428E6E3A447784A06B8A520B4F11587D28F769CBE6C7D`、`E9497A963FFF83858AEDC3294299D746525EB69087ABF91889050BE39D1A2CB2`。

## 后续事项（不阻碍本轮代码收尾）

| 事项 | 引经据典 | 现状 | 怎么办 | 完成条件 |
| --- | --- | --- | --- | --- |
| 补充总体 DESIGN 的协作规则 | `SID#0.1.DESIGN` | 目录职责已同步；状态管理生命周期、前后端协作、身份、数据更新和 SSR 章节仍不完整 | 由人类参考 `SID#0.1.TMP-GOOD-DESIGN` 和 `SID#0.1.TMP-CONTENT-UTILS-REFACTOR` 的后续核对选择适用内容，保留纯业务工具可留在 utils 的当前边界 | 每类状态有唯一维护者及创建、复用、重置、释放规则；身份、请求隔离、旧结果拒绝、数据更新和水合边界可追溯到实际实现；不重复目录调整或写成 Content 文件清单 |
| ~~补齐附件打开能力的覆盖缺口~~ | ~~已按人类审核完成（2026-11-05 22:39 批次）~~ | `panel.test.ts` 新增 `open_url` 与签名下载分流断言，目标测试通过 | — | — |
| ~~替换附件剩余 UI 源码切片测试~~ | ~~已按人类审核完成（2026-11-05 22:39 批次）~~ | 重命名／新建目录及跨组件复制拖放场景已迁入真实组件测试（`Workspace.nuxt.test.ts`、新增 `Markdown/Editor.nuxt.test.ts`），`workspace-model.test.ts` 与 `attachment-drag.test.ts` 的 VM 用例及专用导入已删除 | — | — |
| 替换 Markdown 剩余三项 VM 测试 | ~~已按人类审核完成（2026-11-05 23:16 批次）~~ | 只读拒绝由 `Editor.nuxt.test.ts` 真实 drop 测试覆盖；模式绑定改经真实模式按钮与 `defineExpose` 断言；灯箱清理改由 `Preview.nuxt.test.ts` 真实挂载验证。`Editor.test.ts` 三项全部替代后已删除 | — | — |
| 补附件全局监听器的生命周期覆盖 | ~~已按人类审核完成（2026-11-05 23:16 批次）~~ | 新增 `List.nuxt.test.ts`（框选中卸载后 pointer／blur 不再触发选择）与 `Card.nuxt.test.ts`（长按正向对照 + 卸载取消） | — | — |

后续代码工作的最小批次（补 `open_url` 行为单测、替换附件剩余两处 VM 测试并同步实际验收记录）已于 2026-11-05 22:39–23:10 按人类审核执行完毕；剩余的 Markdown 三项 VM 测试替换与附件生命周期 P2 补测已于 2026-11-05 23:16–23:30 批次完成。结果均记录于 `SID#0.1.TMP-CONTENT-UTILS-REFACTOR` 的实施记录。前端测试改造待办至此清空，唯一剩余事项为总体 DESIGN 规则核定，等待人类后续授权。

## 工作经验

- 业务入口应同步取得 Vue/Nuxt 上下文并先注册查询与生命周期，再向页面暴露 `ready`；页面可在完成自身 setup 后等待该屏障。
- 服务端资源继续由 `useSyncedData` 管理；将查询装配放进 feature 不等于建立第二套查询 store。
- UI 拆分不应把表单实例、滚动目标和确认弹窗硬塞进业务模块。组件负责这些交互细节，feature 负责 API、业务分流和 pending 状态，边界更容易验证。
- 401 去重必须同时限制并发窗口和应用实例，不能用永久布尔值吞掉后续会话失效，也不能让不同 SSR 请求共享退出任务；身份清理仍需经过不依赖 `useApi` 的底层 auth 通道。
- “纯业务协议”和“浏览器载体”应分别落位：拖放 Markdown 与附件 payload 规则可归 feature，`DataTransfer`、鼠标选择、PrimeVue 菜单和 DOM 观察器归组件交互；feature 需要打开或保存 URL 时接收窄接口。
- 公共 utils 不能隐式读取部署配置。LQIP 验证所需大小限制由渲染调用方显式传入，才能让服务端字符串渲染、Vue 组件和测试共享同一条可核对规则。
