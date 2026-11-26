# DESIGN：开发工作流

- 本文档状态：DONE
- 覆盖范围：开发环境搭建、日常开发、配置变更、数据库结构变更、提交与合并
- 非权威文档引用：`SID#1.1.AGENT-DESIGN`

## 日常

| 场景 | 怎么做 | 说明 |
| --- | --- | --- |
| 首次配置或换机 | `pnpm dev:cert --install` | 本机生成并信任开发 CA 及 `localhost` 证书 |
| 启动 | `pnpm dev` | 数据库没有表时会自动执行当前基线及其后的迁移；基线已包含的历史迁移不会重复执行；已有表的库不会自动迁移（只提示或报错），手动执行方式见下；会检查开发 ESA 函数的活动版本、路由和非机密配置等是否正确，若不正确需手动发布，见下 |
| 发布开发 ESA 函数 | 先跑 `pnpm esa:deploy:dev --check` 检查，需要更新时再跑 `pnpm esa:deploy:dev` | 等开发授权回调就绪后执行 |
| 停止 | `Ctrl` + `C` | 只停 Nuxt、代理和 frpc；Docker 依赖继续运行 |
| 停掉 Docker 依赖 | `pnpm dev:stop` | 只停 Docker 依赖，数据卷保留 |
| 只调 Nuxt | `pnpm dev:app` | 不启动 Docker 与隧道 |
| 登录测试 | 用测试账号：管理员 `admin`（手机号 `10000000000`）、普通用户 `user`（手机号 `10000000001`），密码均为 `AaAaAaAa888` | 保持 `NUXT_OTP_DEBUG=true`，否则会发真实短信——永远不要给这两个号码发验证码 |

## 改东西

| 场景 | 怎么做 | 注意 |
| --- | --- | --- |
| 改公开业务参数 | 改 `config/app-settings.yaml`，`pnpm settings:generate` | 不要手改生成文件（`*.generated.ts`） |
| 改部署配置 | 改 `config/shared.yaml` / `dev.yaml` / `prod.yaml`；本机临时覆盖用 `config/local.yaml` | 禁止密钥写进 YAML |
| 改环境变量 | 直接改 `.env.dev`（或 `.env.prod`） | 见下文 |
| 更改环境变量定义 | 改 `.env.*.layer` 模板，随后跑 `pnpm env:build:dev`（或 `pnpm env:build:prod`）更新 `.env.dev`（或 `.env.prod`） | 见下文 |
| 改了的生产环境变量文件 | 改 `.env.prod`，用 `pnpm env:encrypt` 加密为 `.env.prod.gpg`，随后提交 `.env.prod.gpg` | `.env.prod.gpg` 暂存后的 pre-commit 会用 `env:check` 自动核对二者一致 |
| 加依赖 | `pnpm add`，提交 `pnpm-lock.yaml` | 只用 pnpm |
| 新增数据库迁移 | 在 `migrations/` 末尾新增带时间戳的 `.sql` 或 `.ts` | 迁移按文件名顺序执行；执行前须先登记迁移摘要 |
| 登记迁移摘要 | 同一提交里更新 `scripts/migration/frozen.test.ts` | SQL 登记文件摘要；TS 登记包含依赖闭包的打包产物摘要 |
| 执行数据库迁移 | 先用 `pnpm migrate:dev --status` 检查，再执行迁移 | 普通迁移用 `pnpm migrate:dev` 即可；维护迁移须先手动停止应用和其他写入，再加 `--maintenance`——该参数只放行维护迁移，不会自动停写；详见下文 |

### `pnpm env:build:*` 特性

`pnpm env:build:*` 命令以 `.env.*.layer` 为模板，利用 `.env.<dev/prod>`（`<dev/prod>` 指 `dev` 或 `prod`）的已有值，构建一份新的、统一格式的 `.env.<dev/prod>`。

- 模板中无默认值的必需变量填 `<required>`，空值也算默认值；
- 目标 `.env.<dev/prod>` 中的已有值优先于模板的默认值；
- 目标 `.env.<dev/prod>` 中任何 `<required>` 值都按未填写处理；
- 交互终端会询问缺失或值仍为 `<required>` 的必需变量；允许回车跳过；
- 所有模板均未定义的本地变量会保留；在模板中已定义、但不适用于当前环境的变量都会被移除。

### 普通迁移与维护迁移

- **普通迁移**：经过审核，确认与正在运行的应用兼容，允许在线执行；
- **维护迁移**：须先停止应用和其他写入，再执行迁移，期间数据库保持运行；`--maintenance` 只是允许执行维护迁移，不会自动停写。
- 新增 SQL 和 TS 默认都属于维护迁移；普通迁移需要显式声明；
- 已执行的 SQL 一个字节都不能改；若有调整须新增版本。TS 迁移执行完应定新基线并删除（见 `SID#1.1.AGENT-DESIGN`）。

## 提交与合并

| 场景 | 怎么做 |
| --- | --- |
| 开分支 | 从最新 `main` 开，命名 `type/scope/hyphenated-description`，全小写 |
| 提交 | 标题 `type(scope): description`，一行英文祈使句，无句号，无正文；pre-commit 会通过 `lint-staged` 检查并自动修复匹配的暂存文件 |
| 开 PR | 按 PR 模板（`.github/pull_request_template.md`）填写 |
| 合并 | 只用 squash；消息为 PR 标题加 ` (#<PR 号>)`，多个提交时在下方按 GitHub 的顺序逐条列出提交标题——`* <commit title>`，标题与列表之间、各列表项之间均空一行 |
| 合并后 | 确认 PR 已合并、原分支没有额外工作后，切回 `main`，执行 `git pull --ff-only` 更新，再删除原本地分支 |

- `type` 取 `feat`、`fix`、`docs`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`；
- `main` 保持线性历史。
