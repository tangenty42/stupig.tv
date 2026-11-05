# CSS 层叠与生产构建一致性调查

调查日期：2026-10-28。源码基线：`348ae2a` 及当前工作区；工作区已有其他任务的修改。本报告独立记录调查证据与建议，不是已实施的样式规范。上一轮已在 `Preview.vue` 移除标题公共规则的 `z-10`，本轮只新增本报告，没有迁移 layer、修改构建配置或部署生产。

本文保留调查时的事实和建议。后续路线已调整为[官方主题 API 与 Tailwind 选择器策略](css-official-apis-validation-2026-10-29.md)，当前接入、生产 / 旧引擎验收和发布门槛从该入口查阅；下文建议不表示已经启用全站 cascade layers。

## 结论

建议采用 **明确的样式归属、生产 CSS 转换回归、兼容性决策后的原生 cascade layers** 三项措施。先补生产与测试构建的差异，再推进跨来源分层。仅启用 PrimeVue 的 `cssLayer`，或把所有组件包进同一个 layer，都不能系统性解决目前的问题。

本次标题故障的准确根因是 **生产 CSS 转换生成了权重不同的 `:-webkit-any()` 规则**，并非原先所说的“公共规则被排到标题规则后面”。实际生产 CSS 中公共规则仍在前面；即便交换顺序，前缀规则依然覆盖各级标题。此前关于加载顺序的判断应以本报告为准。

项目同时确实存在另一类顺序问题：PrimeVue 在运行时注入主题规则，与应用覆盖样式竞争。历史提交 `574776f`（`fix(ui): keep rounded corners in production by scoping PrimeVue overrides to html:root`）和现有 `primevue-overrides.css` 已明确记录这类问题。两类故障需要分别治理。

## 证据范围与限制

本轮进行了以下只读检查及隔离实验：

- 用 DevTools 读取 `https://stupig.tv/content/1` 正在加载的 CSS，核对标题规则的实际文本和顺序。
- 在独立空白页的 Shadow DOM 中比较标准选择器、前缀选择器、规则反序、同层与跨层的计算样式。
- 使用本机安装的 Vue SFC 编译器、项目 Tailwind 配置、Autoprefixer 和 Lightning CSS，在内存中编译真实 `Preview.vue` 样式，再交给浏览器检查六级标题。
- 检查 Nuxt/Vite/legacy 插件的安装源码、生产 Docker 构建、浏览器测试启动器、全局样式和组件覆盖。
- 用真实 Tailwind 3 编译器验证原生 layer 包装；用安装的 PrimeVue 主题生成器验证开启 layer 后组件规则与变量的输出。

未运行完整 Nuxt 构建、全量 E2E 或旧版本浏览器；没有访问生产后台、用户访问统计或部署日志。浏览器实验使用当前 Chromium，不代表 Chrome 80、Firefox 78、Safari 13.1 的完整验收。本地依赖版本是调查时安装版本，未证明线上镜像使用完全相同的依赖树。

本机相关版本：Nuxt 4.6.1、Vite 8.3.3、Vue SFC 编译器 3.5.43、Tailwind 3.4.19、Autoprefixer 10.6.1、Lightning CSS 1.33.0、`@teages/nuxt-legacy` 3.0.1、`@vitejs/plugin-legacy` 8.2.3、PrimeVue 4.5.5、`@primeuix/styled` 0.7.4。后续复验应以 [pnpm-lock.yaml](../../pnpm-lock.yaml) 与实际安装版本为准。

## 1. 标题故障：转换改变选择器权重

### 1.1 生产产物没有把公共规则移到后面

本次读取的资源是 `/_nuxt/useAttachmentPanel.j5OfVuGN.css`。哈希仅用于定位本次证据，不应写进测试或业务代码。与标题层级有关的规则按下列顺序出现，以下省略不相关属性及具体 scoped 哈希：

```css
.story-body[data-v-example] :-webkit-any(h1, h2, h3, h4, h5, h6) {
  z-index: 10;
}
.story-body[data-v-example] :is(h1, h2, h3, h4, h5, h6) {
  z-index: 10;
}
.story-body[data-v-example] h1 {
  z-index: 30;
}
.story-body[data-v-example] h2 {
  z-index: 29;
}
```

后面的规则还依次给 h3–h6 设置了 28、27、26、25。修复代码并非完全没被部署：生产资源里已有这些值，但浏览器选中了公共前缀规则的 10。

标准 `:is(h1, …)` 使用参数的选择器权重；这里与后面的 `h1` 规则同权重。Chromium 中的旧式 `:-webkit-any(h1, …)` 按伪类贡献权重，使公共规则胜过具体标签规则。因此重新排列 CSS 文件、重新排列这两条规则，都没有解决此例的依据。

### 1.2 最小浏览器实验

实验均使用同一结构：带 `.story-body` 与 scoped 属性的容器，内部包含一个 h1。没有站点全局样式、异步请求或生产页临时覆盖干扰。

| 输入 | h1 的计算 `z-index` | 说明 |
| --- | --- | --- |
| 标准 `:is()` 公共规则在前，h1 规则在后 | 30 | 符合源码意图 |
| `:-webkit-any()` 公共规则在前，h1 规则在后 | 10 | 已复现生产故障 |
| h1 规则在前，`:-webkit-any()` 公共规则在后 | 10 | 反序不改变结果 |
| 两条规则都放入 `@layer components` | 10 | 同层内仍比较选择器权重 |
| 公共规则放入较低层，h1 规则放入较高层 | 30 | 不同层可以明确覆盖关系 |

进一步读取真实 [Preview.vue](../../app/components/MyContent/Markdown/Preview.vue) 的 style 块，用项目 Tailwind 配置展开 `@apply`、进行 Vue scoped 编译与生产目标的 CSS 转换，再在浏览器中计算 h1–h6：

| 真实组件样式版本 | h1–h6 的计算层级 |
| --- | --- |
| 恢复公共 `z-10` 的故障版本 | `10, 10, 10, 10, 10, 10` |
| 当前移除公共 `z-10` 的版本 | `30, 29, 28, 27, 26, 25` |

这证明当前局部修复针对真实冲突有效。生产整页的最终验收仍需在发布后完成，不能把内存编译实验当作已经部署。

### 1.3 转换链与开发/测试差异

[nuxt.config.ts](../../nuxt.config.ts) 配置了 Tailwind、Autoprefixer 和 legacy 模块，但没有显式设置 `vite.build.cssTarget` 或 `cssMinify`。安装源码表明：

1. `@vitejs/plugin-legacy/dist/index.js` 的 `vite:legacy-config` 钩子在客户端 build、生成 legacy chunks 且未指定 `cssTarget` 时，设置 `cssTarget = "chrome61"`。
2. 这里的 `cssTarget` 不等于项目传给 legacy 插件的 JavaScript `targets: ['chrome >= 80']`。
3. 当前 Vite 的 CSS 压缩路径会调用 Lightning CSS，并把 `build.cssTarget` 转为其目标。即使没有配置 `css.transformer: 'lightningcss'`，也不能据此断言构建未使用 Lightning CSS。
4. Lightning CSS 面向旧目标时为简单 `:is()` 参数生成 `:-webkit-any()` 等前缀规则；官方说明也描述了这个转换。[Lightning CSS 转换文档](https://lightningcss.dev/transpilation.html#is-selector)

使用同一段标题 CSS 的本机转换结果：

| 处理方式 | 是否生成 `:-webkit-any()` |
| --- | --- |
| Autoprefixer，development 配置 | 否 |
| Autoprefixer，production 配置 | 否 |
| Lightning CSS，Chrome 61，开启 minify | 是 |
| Lightning CSS，Chrome 80，开启 minify | 是 |
| Lightning CSS，Chrome 99 / 111，开启 minify | 否 |

因此，单把目标从 Chrome 61 改到 Chrome 80 也不能修复这一选择器问题。前缀规则同样会被支持它的现代 Chromium 匹配，影响不限于旧浏览器。

源码和局部实验共同解释了线上产物；本轮没有重跑线上镜像的完整构建，不能将其描述为已采集该镜像的 resolved Vite config。后续 CI 应记录最终 CSS target、minifier 与 Browserslist 环境，避免仅凭顶层配置推断。

## 2. 项目的样式来源与覆盖风险

| 来源 | 当前机制与证据 | 建议 |
| --- | --- | --- |
| Tailwind Preflight、工具类 | [global.css](../../app/assets/css/global.css) 的三个 `@tailwind` 入口；[Tailwind 配置](../../tailwind.config.ts) 使用 v3 与 PrimeUI 插件 | 原生分层时分别放入基础层和工具层；不能把 Preflight 留在未分层区域 |
| 全局应用样式 | `global.css` 混合原始顶层规则、Tailwind `@layer base/components`、全局控件过渡、图片状态、第三方覆盖 | 按归属迁移；先检查广泛的标签/角色选择器，不按文件整体盲目归层 |
| Vue scoped 样式 | `app/` 中检查到 20 个带 style 块的 Vue 文件；9 个 Vue 文件使用 `:deep()` | scoped 限制匹配范围，不提供独立的 cascade layer；父组件 deep 覆盖仍可与子组件规则竞争 |
| PrimeVue 主题 | `cssLayer: false`；主题在运行时生成规则及变量 | 可在兼容策略确定后统一进入 `primevue` 层；优先用 preset/design tokens 表达主题值 |
| PrimeVue 覆盖 | [primevue-overrides.css](../../app/assets/css/primevue-overrides.css) 用 `html:root`、重复类名和更具体选择器抗衡注入顺序 | 保留已验证的修复，逐项迁移后再减权重，不能先批量删除 |
| Viewer、Cropper、图标 | Viewer/PrimeIcons 在 Nuxt 全局 CSS 列表；Cropper CSS 在 [头像组件](../../app/components/MyAvatarCropUpload.vue) 中导入 | 评估全局与懒加载两种入口，统一第三方层归属，避免重复导入一份未分层副本 |
| CodeMirror | [themes.ts](../../app/utils/content/editor/themes.ts) 使用 `EditorView.theme()` 动态生成 CSS；[Editor.vue](../../app/components/MyContent/Markdown/Editor.vue) 还覆盖其 DOM | 优先把编辑器主题调整放回主题 API；动态样式与静态覆盖应一起处理 |
| CAPTCHA、首屏遮罩与行内样式 | 第三方 SDK、Nuxt head 中的遮罩、Vue/JS 的尺寸与位置样式 | 分别标记为外部边界、应用启动样式、运行时几何值；layer 不替代这些机制 |

这里的文件计数排除了测试，只是工作区快照，不应成为静态测试断言。

需要重点检查的现有覆盖关系：

- `global.css` 的 `html :is(button, …, [role='button'], …)` 与图片、Dialog、其他浮层的过渡。全局控件默认值应低于组件自己的动画，而不能靠每个组件持续增加权重。
- `Editor.vue` 对 Markdown 标题全宽边距的 deep 覆盖，与 `Preview.vue` 的正文标题规则。即使两者未来都在 `app-components` 层，也必须明确编辑器上下文如何覆盖预览默认值。
- 全局 h2 的 `!text-xl`、模板中的 `!bg-*` / `!p-*`、Cropper 和 CAPTCHA 的 `!important`。这是需要审计的覆盖，不意味着它们全部错误；层迁移可能改变重要声明之间的胜负。
- CodeMirror 的动态未分层样式。如果只把当前静态覆盖放进命名层，普通未分层规则会优先，编辑器可能出现新的样式回退。

## 3. 原生 layer 能解决什么

预先声明层顺序后，来自不同文件、不同加载时机的规则可以按归属决定优先级，不再靠碰巧先后加载。适合管理 reset、第三方组件库、应用组件与工具类之间的覆盖。

但有四个边界：同层仍比较权重和顺序；普通未分层样式优先于命名层；`!important` 会反转层优先级；层顺序由首次声明建立，晚来的声明不能修正已经建立的相对顺序。行内样式、继承和 DOM 的 stacking context 也不会因分层而消失。[CSS Cascade Level 5](https://drafts.csswg.org/css-cascade-5/#layer-order)

所以本次修复无需为了两个 z-index 新建全局 layer：公共标题样式根本不需要再提供一个与所有级别竞争的层级默认值。对于确需“默认值 → 变体 → 状态”的组件，可以使用受控的子层或明确的状态/上下文选择器，但不建议给每个修复创建一个临时最高层。

### 3.1 Tailwind 3 的 `@layer` 不是已经完成的原生分层

Tailwind 3 会把 `@layer base/components/utilities` 中的内容移动到相应 `@tailwind` 位置，执行保留/裁剪等构建处理。当前文件中的这几个关键字不能当成浏览器已有同名原生层的证据。[Tailwind 3 指令说明](https://v3.tailwindcss.com/docs/functions-and-directives#layer)

本轮实测可使用不同名字包住 Tailwind 入口，使最终 CSS 保留原生 layer。下面是方案示意，不是已经应用的配置：

```css
@layer tw-base, vendor, primevue, app-base, app-components, app-overrides, tw-utilities;

@layer tw-base {
  @tailwind base;
}

@layer app-components {
  @tailwind components;
}

@layer tw-utilities {
  @tailwind utilities;
}
```

现有自定义 `@layer base` 会随 Tailwind 输出进入 `tw-base`；哪些网站排版规则应另归 `app-base`，需要显式迁移。SFC 的 style 块也不会自动归入 `app-components`，必须单独处理。`@apply` 展开到当前规则里，不会让当前规则自动继承工具层归属。

### 3.2 建议的层职责

| 层，按普通声明从低到高 | 归属 |
| --- | --- |
| `tw-base` | Tailwind reset 与基础初始化 |
| `vendor` | 能通过构建导入控制的第三方静态 CSS |
| `primevue` | PrimeVue 组件、主题变量及其状态样式 |
| `app-base` | 网站排版、颜色与控件默认行为 |
| `app-components` | 自有组件及共享展示类 |
| `app-overrides` | 有具体所属组件和原因的第三方适配、跨组件上下文覆盖 |
| `tw-utilities` | 模板中显式使用的工具类 |

工具层放最后，意味着模板工具类可覆盖普通组件样式，包含一些当前因 scoped 权重较高而不会生效的工具类。这是有意的语义变化，必须做界面回归。不可被模板覆盖的组件约束应重新设计归属，不能假设迁移前后所有胜负自然相同。

层顺序只设一个项目权威定义，并让 SSR 首屏在任何层内容出现前输出声明；不能等某个懒加载组件第一次打开时才建立顺序。PrimeVue theme 的 `cssLayer.order` 与 Nuxt 模块的 `cssLayerOrder` 不应维护两份不一致的字符串。安装的 `@primevue/nuxt-module` 有前置注入 layer-order 的入口，可作为候选；最终必须检查实际 SSR HTML、hydration 后的 head 和客户端导航，证明它的时序满足要求。

本轮调用安装的 `@primeuix/styled` 生成器验证：开启 `cssLayer: { name: 'primevue', order: '…' }` 后，普通组件规则与 `:root,:host` 主题变量都包入 `@layer primevue`。这与主题覆盖治理相关，但不证明外部 SDK、CodeMirror 或所有 PrimeVue 辅助样式都已经被分层。配置能力见 [PrimeVue 4 主题文档](https://v4.primevue.org/theming/styled/#options)。

对已有圆角、阴影、输入样式等主题值，优先评估 Aura 自定义 preset；确需 CSS 的覆盖再放入应用覆盖层。要保留深浅色 token 结构和版本限制，例如现有菜单 label 字号注释已说明当前模板不读取对应 token，不能机械地把每条覆盖改成一个不存在或未使用的 token。

## 4. 旧浏览器是迁移前置决策

[package.json](../../package.json) 的 production Browserslist 声明 Chrome/Edge 80、Firefox 78、Safari 13.1 起；JavaScript legacy targets 只显式写了 Chrome 80；CSS 还受前述插件默认 Chrome 61 影响。三个入口没有形成清楚、可验证的一份兼容合同。

原生 cascade layers 的实现起点包括 Chromium 99、Firefox 97、Safari 15.4；当前声明包含不支持它的浏览器。[Chrome 官方发布说明](https://developer.chrome.com/blog/cascade-layers)

本机将一个 `@layer` 示例交给 Lightning CSS 1.33.0，指定 Chrome 80 且开启压缩，输出仍保留 `@layer`。因此不能假设现有 legacy/Autoprefixer/Lightning CSS 配置会自动把 layer 转成老浏览器可用的等价 CSS。不识别该 at-rule 的浏览器会丢弃对应块，风险是样式缺失，不只是优先级不同。

| 方案 | 适用条件 | 本项目建议 |
| --- | --- | --- |
| 提高 CSS 最低支持版本，使用原生 layer | 产品接受停止支持不具备 layer 的浏览器，并验证其他实际使用的 CSS/JS 能力 | 作为长期首选，但本轮没有访问数据支持直接决定版本门槛；layer 的支持版本也不是整个应用的充分兼容条件 |
| 保留旧浏览器，暂不全站引入原生 layer | 现有兼容声明仍有效 | 当前可立即走的保守路径：稳定选择器、减少重复属性覆盖、使用主题 API、对齐生产 CSS 测试 |
| 增加 layer 降级处理 | 能统一处理完整样式集合，并解决动态生成的样式 | 不建议作为当前首选，需要独立原型与构建评估，不能只追加一个 PostCSS 插件 |

`@csstools/postcss-cascade-layers` 通过增加选择器权重模拟层；其文档明确要求处理完整 CSS bundle，逐文件或并行处理会产生错误结果。本项目有分块 SFC、路由懒加载和运行时 PrimeVue/CodeMirror CSS，直接挂到每个文件的 PostCSS 管线不能覆盖这些边界。[插件官方限制](https://github.com/csstools/postcss-plugins/tree/main/plugins/postcss-cascade-layers#readme)

不要用关闭 CSS 分包来代替上述决策：它不能消除选择器权重变化，也不能合并尚未生成的运行时主题。关闭压缩、更换压缩器或大量追加 `!important` 可用于定位问题，不应在没有兼容性和产物验证的情况下成为全站长期方案。此次治理也不需要顺带升级 Tailwind 4。

## 5. 测试为什么漏掉了生产差异

现有 [标题浏览器用例](../../tests/e2e/content-sticky-headings.spec.ts) 检查高层标题是否盖住退出的低层标题，包括 `elementFromPoint()` 和不透明背景。它检查的是有价值的可见行为，不需要用源码字符串断言替代。

问题在于 [浏览器启动器](../../scripts/testing/browser.ts) 明确执行：

```ts
base.modules.filter(module => module !== '@teages/nuxt-legacy')
```

测试确实构建 Nuxt，并非只跑开发服务器；但移除 legacy 后不会继承其 `cssTarget = 'chrome61'` 副作用。测试启动器还显式设置 `NODE_ENV: 'development'`，而 [Dockerfile](../../Dockerfile) 设置 production 后执行 `pnpm build`。Vite 的 build 模式与传入的环境变量不是同一个概念，需检查最终配置及 `BROWSERSLIST_ENV`，不能简单按命令名认定目标一致。当前 [Playwright 配置](../../playwright.config.ts) 只选 Desktop Chrome，也不验证旧浏览器支持声明。

### 建议补齐的验证

| 验证层 | 检查内容 | 能防住的问题 |
| --- | --- | --- |
| 轻量 CSS 管线回归 | 读取真实 SFC，经 scoped、Tailwind、Autoprefixer、生产 CSS target/minifier 转换；浏览器检查结果 | 此次前缀转换问题；避免测试手写一份永远正确的替代 CSS |
| 构建配置一致性 | 保存有效 CSS target、minifier、Browserslist 环境及关键依赖版本；测试与生产共用明确配置 | legacy 插件、环境默认值或依赖升级悄悄改变产物 |
| 少量完整生产前端构建场景 | 保留真实 legacy/CSS 管线，继续使用隔离数据库和云服务夹具 | SSR 内联 CSS、抽取 chunk、运行时注入之间的差异 |
| 加载顺序场景 | 硬导航、站内跳转、首次打开浮层/编辑器；改变独立组件 chunk 的到达顺序 | 首次建立 layer 顺序、动态注入覆盖、跨组件覆盖 |
| 兼容性验收 | 按最终支持合同选择引擎和版本；仅修改 UA 不能模拟旧 CSS 引擎 | 旧浏览器忽略 layer 或其他不支持语法 |

轻量回归可先延续当前兼容目标，覆盖标题的六级计算层级、实际重叠区域命中对象、深浅色背景。故障版本必须在该测试中失败，当前移除公共 `z-10` 的版本必须通过。

全站 layer 原型至少验收：标题吸顶与全屏编辑器边距、Dialog/ConfirmPopup 动画、分页器选中态、表单 invalid/disabled、头像裁剪、Viewer、CodeMirror 提示与选区。每项都要涵盖首次使用与再次打开，深浅色切换；几何和命中测试优先于仅依赖截图肉眼判断。

不要求任意交换同一组件内所有规则后都保持结果；组件内部合法的顺序关系仍然存在。重点是验证本应互不依赖的文件与运行时注入，不能意外改变已约定的跨来源覆盖。

## 6. 推荐实施顺序与验收门槛

### 阶段一：修复当前缺陷并让验证覆盖生产转换

保留现有标题局部修复，增加真实 CSS 管线回归；明确生产和测试共用的 CSS target/minifier 配置，同时记录 legacy 插件是否仍改写最终值。若保留旧浏览器，显式 Chrome 80 目标仍会产生本次前缀，因此配置对齐与局部修复都需要。

梳理 `Preview.vue`、`Editor.vue` 和全局控件规则中依赖 `:is()` 标签列表权重的覆盖。可优先消除不必要的公共属性；确需分组时可评估逗号选择器，但必须检查最终压缩产物，不能假设工具绝不会重新合并。不直接把它们全部换成 `:where()`，其零权重与旧浏览器支持同样需要验证。

完成标准：故障版本可被回归检出，修复后六级标题为 `30…25`，生产相同转换配置下的实际吸顶不再遮挡。

### 阶段二：先确定兼容合同，再做有限范围 layer 原型

明确旧浏览器是否仍是需要兑现的支持范围，并统一 JavaScript targets、Browserslist 与 CSS target 的来源。没有访问数据时，不把“旧浏览器大概没人用”写成事实。

若允许采用原生 layer，先在 Tailwind reset/工具类、PrimeVue、应用覆盖之间建立顺序，验证 SSR 首次声明、运行时变量和浮层样式。默认保留现有 `html:root` 等修复，待同一回归证明它们已无必要后再逐项简化。第三方动态未分层样式需有明确例外清单及归属，不能全站机械包裹。

完成标准：层顺序在首屏及懒加载路径一致；Preflight 不压过组件库；普通工具类按约定覆盖组件；旧兼容策略明确；重要声明的反向层顺序经过审计。

### 阶段三：迁移应用样式并约束新增代码

逐模块迁移全局应用规则、20 个 SFC style 块及第三方适配；编辑器动态主题单独处理。运行时位置/尺寸仍由现有 JS/行内值负责，避免把样式分层改造成交互逻辑重写。

稳定后，把层归属、例外处理和验证入口分别写入现有前端规则与开发测试指南。可增加针对新出现未分层样式、未知层名、目标配置漂移的轻量检查；基于 CSS 解析结果检查，并保留有理由的运行时/第三方例外，避免简单正则误伤 Tailwind 指令或生成代码。不为了本次报告预先引入 Stylelint 等依赖。

完成标准：每个样式来源都有归属；不能迁移的动态边界有解释和回归；核心 UI 不再依赖第三方 style 插入时机；项目不再用零散加权重作为默认修复手段。

## 7. 可复验的最小转换探针

在项目根目录使用现有 Node 依赖执行以下 ESM 代码即可观察转换，不需要构建 Nuxt、安装新包或连接服务：

```js
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const nuxt_require = createRequire(require.resolve('nuxt/package.json'))
const { transform } = nuxt_require('lightningcss')
const css = '.story-body[data-v-probe] :is(h1,h2){z-index:10}.story-body[data-v-probe] h1{z-index:30}'

for (const version of [61, 80, 99]) {
  const result = transform({
    filename: 'heading-probe.css',
    code: Buffer.from(css),
    targets: { chrome: version << 16 },
    minify: true,
  })
  console.log(version, result.code.toString())
}
```

把输出用于空白页面中的 `<div class="story-body" data-v-probe><h1>Heading</h1></div>`，读取 h1 的 `getComputedStyle(...).zIndex`。本次 Chrome 61/80 目标产物得到 10，Chrome 99 目标得到 30。该最小例用于说明原因；正式回归应读取真实组件和项目配置，避免与实现脱节。

## 文档验证

本报告的相对文件链接已检查，无缺失目标；文件使用无 BOM 的 UTF-8。全仓 ESLint 通过已安装的入口执行，报告了本轮未修改的 [useStoryEditSession.ts](../../app/composables/useStoryEditSession.ts) 中两个 unused-vars 错误：`begin_operation`、`operation_current`。未为使文档检查通过而改动该任务的代码；本报告没有 ESLint 错误。完整 Nuxt 构建和 E2E 未执行，前文已逐项区分静态检查、内存编译与浏览器实验。

## 待决定事项

下一步的实质决策是最低浏览器支持范围，以及是否接受“模板普通工具类高于应用组件普通规则”的层级语义。当前可以先实施生产 CSS 管线回归和配置对齐，不必等待全站 layer 迁移。本报告未将上述建议视为已授权实施的依赖、构建或兼容性变更。
