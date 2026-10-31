# 生产 CSS 构建一致性验收

日期：2026-10-29。范围：此前[官方主题 API 开发接入](css-official-apis-validation-2026-10-29.md)之后的生产产物验收；不包含真实最低旧引擎、线上发布或缓存回滚演练。

本页保留首次生产一致性验收的结果和计数。当前交付范围、后续 6 场景复验及发布门槛以[CSS 当前入口](css-official-apis-validation-2026-10-29.md#当前交付与证据)为准；不把本页历史计数累加为最新测试总数。

## 验收路径

```powershell
pnpm exec playwright test --config tests/css-production.config.ts
```

[生产测试配置](../../tests/css-production.config.ts)调用[现有启动器](../../scripts/testing/browser.ts)，从当前工作区复制应用到独立目录，创建随机命名的本地 E2E 库并执行迁移，再构建完整 Nuxt 应用。legacy 模块保留，仅构建子进程使用 production NODE_ENV；业务配置和运行服务仍使用开发隔离配置，OSS / CAPTCHA / SMS 等原有边界继续由测试实现替代。结束时停止本轮服务、删除本轮数据库和临时运行凭据，保留公开的编译证据及诊断产物。

新建的两条样式验收页面和懒加载 Dialog 只存在于测试 Nuxt layer，不加入真实应用路由。其 class 通过夹具构建的额外 Tailwind content 生成，不向产品 Tailwind 配置添加测试目录。

## 生产配置与实物证据

原配置的 legacy JS 只声明 Chrome，而 CSS target 未显式配置，可能由 legacy 插件赋予另一默认值。现在统一以 package.json 的 production Browserslist 为入口，[browser-targets.ts](../../config/browser-targets.ts)保留四种引擎的最低版本，并拒绝未映射引擎。

实际 Vite `configResolved` 报告已确认：

| 字段 | 观测结果 |
| --- | --- |
| 构建 NODE_ENV / mode / isProduction | `production` / `production` / `true` |
| Browserslist 环境 | `production` |
| CSS targets | Chrome 80、Edge 80、Firefox 78、Safari 13.1 |
| CSS minifier | Lightning CSS |
| CSS code splitting | 开启 |
| JS minifier | Oxc |
| CSS / legacy JS chunks | 最终通过的完整构建分别为 16 / 182 个，数量仅为本轮观测 |

报告在 `.dev/e2e/<run>/css-build.json`，浏览器结果、trace 和截图在 `.dev/css-production/`。报告只记录编译参数、插件名和公开资产名 / 大小，不包含运行配置或凭据。legacy 插件存在、最终 legacy 资产存在、SSR HTML 包含 nomodule 加载路径均有检查；现代 Chromium 不会因此执行旧版浏览器分支。

## 发现并修复的问题

**分页器选中态：** 首轮生产测试选中页文字为 `rgb(4, 120, 87)`，未达到既有白字要求。原重复 class 的 CSS 覆盖没有压过运行时组件规则。已将选中背景 / 文字迁到 preset 的 `paginator.navButton.selectedBackground / selectedColor`，保留 primary-500 背景和白字，移除该重复 class 覆盖；隔离真实组件回归也增加浅深色白字断言。

**夹具 class 生成：** 首轮懒加载 Dialog 的 `p-0` 未进入原有产品 content 扫描，最终资产没有对应 utility，实际内边距仍为 `20px`。已仅在测试构建里把 E2E layer 加入 Tailwind content，保留内边距必须为 `0px` 的断言。

**夹具生命周期：** 首个 Dialog 夹具关闭时直接卸载外层组件，绕过了库内部退出过渡。已将“首次加载”与 visible 状态分开，保持组件挂载并通过公开 visible 属性关闭，继续要求 `card-out` 事件；没有删除动画检查来换取通过。

## 浏览器覆盖与限制

- 无页面 JS 的 SSR 与正常 hydration 使用同一份真实构建：检查 body 祖先 ID、六级标题 z-index、分页器选中态和翻页。
- 从无预取的起始页导航，主动阻塞并释放真实路由 CSS；再对首次懒加载 Dialog 的 CSS 重复此过程，验证样式到达前组件未提前显示。
- 验证实际 Dialog 的 body Teleport、`321px` 行内宽度、`6.4px` 圆角、PT 内边距及组件 CSS；记录 `card-in` / `card-out` 和 ConfirmPopup 的入场动画及无 scale 行为。
- 复用并扩展真实档案工作流：检查六级标题 `30 / 29 / 28 / 27 / 26 / 25`、实际遮挡命中和末尾吸顶；复用全屏编辑滚动同步工作流。

最终生产浏览器验收 **4 / 4 通过**，耗时约 3.3 分钟，无失败、重试或跳过。对应构建报告为 `.dev/e2e/80d1adbba7254b62b480d5a4e08bb7b0/css-build.json`，Playwright 汇总为 `.dev/css-production/report.json`；临时运行凭据已删除。该轮将验收加入 browser 第一分片，未执行远端 CI；后续 #52 已改为独立的 `browser-css` job，当前入口以 [Check](../../.github/workflows/check.yml) 为准。#54 合并后的 [Check](https://github.com/tangenty42/stupig.tv/actions/runs/41219507950) 已通过；本段测试计数仍属于首次隔离验收。

配套验证：`pnpm test` 共 2037 项通过、1 项既有跳过；Nuxt、scripts 和 tests 类型检查通过。分页器修复的浅色 / 深色真实组件回归 2 项通过。

此路径构建完整应用并运行 Nitro / SSR，但供应商实现、数据库和部署包外部依赖边界仍属于 E2E 配置；不代表本轮已验证真实 Docker 发布镜像、线上 CDN、真实云服务或 Chrome/Edge 80、Firefox 78、Safari 13.1 引擎。后续 `:has()` / `@property`、加载布局及主题改写的真实旧引擎结果见[媒体与主题记录](css-legacy-engines-2026-10-29.md#媒体与主题兼容改写)，当前门槛由[总览](css-official-apis-validation-2026-10-29.md#发布门槛与剩余工作)维护。

依据：[Vite CSS target / minifier](https://vite.dev/config/build-options.html#build-csstarget)、[legacy 插件 targets](https://github.com/vitejs/vite/tree/main/packages/plugin-legacy#targets)。具体生效行为以本机安装版本及保留的构建报告为准。

后续真实 Chromium 80 / Firefox 78 的安装与独立测试结果见[旧引擎记录](css-legacy-engines-2026-10-29.md)；不将本页的现代 Chromium 通过结果推广为旧版本通过。
