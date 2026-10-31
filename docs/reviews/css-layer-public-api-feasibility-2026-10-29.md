# CSS 分层兼容插件：公开 API 可行性评估

日期：2026-10-29。结论：**当前安装版本的公开扩展点不足以满足完整动态转换合同，按用户确认的边界暂停相关适配；未接入应用或部署。**

这里的暂停只针对自定义动态 CSS 转换插件。后续已采用[官方主题 API 与 Tailwind 选择器策略](css-official-apis-validation-2026-10-29.md)，当前改动、验收与发布条件由该页集中维护；本探针不作为产品运行时 adapter。

本评估记录未采用的自定义分层插件为何停止接入；原长篇设计已移出当前文档，可从 Git 历史回查。首轮范围为动态入口验证及转换原型：旧浏览器的交互与动画效果均须等价，只允许公开 API 和官方扩展点，无法覆盖时暂停重新评估。依赖 patch、内部模块替换及依赖内部接口的包装 / alias 均已排除。

## 可重复的证据

使用已有依赖运行[诊断入口](../../scripts/verify/css-cascade-feasibility.ts)：

```powershell
pnpm exec tsx scripts/verify/css-cascade-feasibility.ts
pnpm exec vitest run --project tools scripts/verify/css-cascade-feasibility.test.ts
```

入口不加载应用配置、不连接数据库或站点、不修改安装包，仅在独立进程内生成样式并使用 happy-dom 观察写入时序。它按各依赖的真实消费者解析安装路径，避免依赖偶然提升；这只是安装版本诊断，不是生产转换核心的依赖接线。输出只包含构造的测试 CSS、版本、计数和字节数，不打印真实主题内容。命令成功退出只表示探针运行成功，不代表适配可行性或旧引擎验收通过。

本机实测版本：`@codemirror/view` 6.43.13、`style-mod` 4.1.4、PrimeVue 4.5.5、`@primeuix/styled` 0.7.4。与设计阶段记录的 CodeMirror 版本不同，因此本评估重新检查了实际安装内容。

### CodeMirror / style-mod

- `new StyleModule(spec, { finish })` 的回调只接收 selector。本次构造的规则同时含普通 `color` 与 important `display`；finish 调用一次，生成一条共用 selector 的规则，不能据此把声明拆到普通 / important 两个不同区间。
- 通过 `basicSetup`、`EditorView.theme()`、`HighlightStyle.define()` 创建真实 `EditorState`，公开的 `EditorView.styleModule` facet 得到 9 个模块、共 5485 UTF-8 字节。由 EditorView 创建的项目主题仍为原始规则，没有经过单独创建的 StyleModule 的 finish。计数是本次观测，不是固定验收常量。
- 再通过公开 facet 增加一个主题，模块数从 9 变为 10。该入口用于提供额外模块，没有把已有模块替换为转换模块。
- 安装版 `@codemirror/view/dist/index.js` 的 `mountStyles()` 在 facet 结果之外再拼入内部基础主题，然后调用 `StyleModule.mount()`。其 `.d.ts` 将 `mountStyles`、`styleModules` 标记为 private；公开的 `EditorView.theme()` / `baseTheme()` 是提供样式的入口，未发现全量挂载前转换扩展点。
- 安装版 `style-mod/src/style-mod.d.ts` 公开 constructor / getRules / mount / newName，mount 的选项只有 nonce，没有接收转换器的参数。修改未声明的 `rules`、替换静态方法或替换依赖模块会越过已确认边界。

因此，“拿到 facet 中的模块”或“给项目主题追加 guard”都不能证明全套 CodeMirror CSS 已受控。保留原始模块、再追加转换副本也不满足插入前转换合同。

安装源码还显示 StyleSet 在 root 内保留已见模块，EditorView.destroy() 没有逐模块卸载调用。后续若恢复原型，应验证固定主题集合重复切换不增长，不能假定库已提供任意动态主题的回收接口。

### PrimeVue

- 安装版 `@primevue/core/usestyle` 的 `watch(cssRef)` 先写 `style.textContent`，再发送内部 `onUpdated` 通知。
- 探针在首次加载及后续更新时观察到的内容分别为原始 red 和 blue 规则。通知返回的 green 规则未被采用，因此这个通知不是提交前的 CSS 转换钩子。该选项也没有出现在安装版 `StyleOptions` 公共类型中，本评估仅用它观察实现时序，不据此建立产品适配。
- SSR 的 `BaseStyle.getStyleSheet()` 独立返回 `<style>` 字符串；本次基础 CSS 为 313 字节。`getCommonThemeStyleSheet()` 则返回另一条主题路径的字符串，本次为 16588 字节并含 `:host`。客户端 useStyle 的通知不会接管这些输出。
- 安装源码中的 `loadCSS()` 不经过 `loadStyle()` 的 Theme.transformCSS 路径。只包装主题转换也覆盖不了基础 CSS，且替换导出的 Theme / BaseStyle 方法不属于官方转换扩展点。

[PrimeVue 4 官方主题 API](https://v4.primevue.org/theming/styled/)提供 preset、token、附加 CSS 和原生 cssLayer 配置；这些能力不等价于对所有基础规则、主题规则、SSR 字符串及客户端更新执行自定义编译。原生 cssLayer 也不能直接满足本项目旧引擎目标。上述不足是结合官方 API 与安装源码作出的当前版本集成结论，不宣称未来版本也必然无法提供接口。

## 其他已确认的兼容输入

评估时 [Preview.vue](../../app/components/MyContent/Markdown/Preview.vue) 的加密图片加载布局及轮播边缘遮罩使用 `:has()`，边缘过渡还使用 `@property`。当时要求保留交互与动画效果，不能通过忽略规则或只登记例外完成验收。本轮在动态入口门槛处暂停；后续官方 API 路线的兼容改写与验证见当前入口，不将本段历史观察视为现行源码描述。

## 交付状态与恢复条件

| 范围 | 当前状态 |
| --- | --- |
| P0 动态入口可行性检查 | 已提供运行探针、对应行为测试及本评估 |
| P0 全量来源 / 权重 / 生产转换链盘点 | 未完成，不能将入口探针当作完整盘点 |
| P1 转换核心、源码分析和 lint | 未开始；没有新增解析依赖或启用任何新规则 |
| P2 框架及动态适配 | 公开扩展点门槛未通过，按约定暂停 |
| P3 / P4、最低旧引擎、全站迁移和上线 | 未执行；需在原型及成本评估后另行决定 |

恢复相关动态适配，需要找到并验证官方支持的全量挂载前扩展点，或重新确定架构与合同。独立的 P0/P1 研究可以与动态接入分开评估，但不能据此声称当前方案已能全站启用。未采用依赖 patch、内部包装、DOM/CSSOM 全局拦截、事后观察修补或原始 / 转换样式混用来绕过限制。

本轮验证不包含 Nuxt 完整构建、SSR/hydration 应用回归、真实旧浏览器、选择器差分、性能预算或生产缓存发布演练。happy-dom 仅用于上述写入时序，不作为浏览器 CSS 层叠正确性的证据。

后续已验证另一条[官方主题 API 与 Tailwind 选择器策略路线](css-official-apis-validation-2026-10-29.md)。它不拦截全套动态 CSS，也不模拟全站 layer，未解除本文所述插件接入门槛。
