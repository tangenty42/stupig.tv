# DESIGN：测试工作流

- 本文档状态：DONE
- 覆盖范围：本地测试命令、测试文件放置、CI 检查

## 测试用账号

开发环境可能存在测试用账号：

| 用户名 | 手机号（假） | 密码 |
| --- | --- | --- |
| admin | 10000000000 | AaAaAaAa888 |
| user | 10000000001 | AaAaAaAa888 |

开启 `NUXT_OTP_DEBUG` 时，用手机号登录，输入任意验证码即可登录。

## 改了什么要跑什么

| 改动 | 至少跑 |
| --- | --- |
| 任何代码 | `pnpm lint` 与相关测试 |
| 类型、导入、文件移动 | 再加 `pnpm typecheck` |
| 页面流程、登录、上传等跨前后端的行为 | 再加 `pnpm test:e2e` |
| 样式 | 再加 `pnpm exec playwright test --config tests/css-production.config.ts`、`pnpm exec playwright test --config tests/css.config.ts` |
| 旧浏览器兼容 | 再加 `pnpm test:css:legacy`、`pnpm test:e2e:legacy` |
| 只改文档 | `pnpm lint`，并核对链接、命令与实现；不用跑应用测试 |
| 数据库迁移脚本、迁移工具 | `pnpm test:tools`；结构回放交给 CI |

想一次跑全：`pnpm check`（参数生成检查、lint、类型检查、全部单测与组件测试，不含浏览器 E2E）。

## 命令

| 命令 | 测什么 | 前提 |
| --- | --- | --- |
| `pnpm test:unit` | 前端、后端、配置的单元测试 | 无 |
| `pnpm test:tools` | 脚本与工具 | 无 |
| `pnpm test:component` | Vue 组件挂载 | 无 |
| `pnpm test:e2e` | 真实浏览器中的页面与 API 流程 | 满足 E2E 共同前提（见下文）、Playwright Chromium |
| `pnpm exec playwright test --config tests/css-production.config.ts` | 生产构建的 CSS、SSR 与布局 | 满足 E2E 共同前提（见下文）、Playwright Chromium |
| `pnpm exec playwright test --config tests/css.config.ts` | 组件 CSS 与层叠边界 | Playwright Chromium；无需应用或数据库 |
| `pnpm test:e2e:legacy` | 历史浏览器与现代 Chromium 上的生产构建 | 满足 E2E 共同前提（见下文）、Playwright Chromium、Windows 历史浏览器夹具 |
| `pnpm test:css:legacy` | 历史浏览器中的工具类 CSS | Windows 历史浏览器夹具；无需应用或数据库 |

### E2E 共同前提

- Docker 可用，且开发 MySQL、Redis、MQTT 已启动；
- `.env.dev` 已配置本地连接信息和 `MYSQL_DEV_ROOT_PASSWORD`；
- 测试端口空闲。

注意：

- Playwright Chromium 首次运行前执行 `pnpm exec playwright install chromium` 安装；
- Windows 历史浏览器夹具包括 Chromium 80、Firefox 78 及匹配的 WebDriver，都放在 `.dev/tools/legacy-browsers/`；
- E2E 启动器会在本地开发 MySQL 实例中新建随机命名的独立测试库，在其中执行当前基线及后续迁移、并创建测试账号，再启动独立的测试应用；结束后会自动清理测试库及测试进程；OSS、短信等在测试时仅使用替身。

## 测试文件命名规范

- 单元测试须放在被测模块旁 `<模块>.test.ts`；
- 组件测试 `<模块>.nuxt.test.ts`；
- 浏览器流程 `tests/e2e/*.spec.ts`，每个场景一个文件。

## CI

- 所有 PR 都会触发 Check（只改 `docs/**` 或 Markdown 的 PR 会跳过应用测试）；
- 除了纯文档推送，所有 `main` 推送均会触发 Check。

完整检查包括：

- `pnpm check`
- MQTT 权限与持久会话
- 浏览器 E2E（分 3 片）
- 生产 CSS 与组件 CSS 层叠边界
- 迁移回放与恢复

`main` 推送对应的 Check 成功后，才进入部署流程。
