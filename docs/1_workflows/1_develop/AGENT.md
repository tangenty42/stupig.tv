# AGENT：开发工作流实现与迁移记录

- 本文档状态：DONE
- 覆盖范围：SID#1.1 的实现核对、旧资料去向、待办及经验
- 旧文档：`docs-legacy/` 已于 2026-11-19 删除；本文提到的旧手册、旧台账以及“留在原文”的内容，原文都在 git tag `docs-legacy-final`
- 基线：2026-11-11 00:16:03 +08:00（Asia/Shanghai）；提交 `722c1cd3392cb4cdb5c8b051f3354c8e3905e355` 及核对时的未提交工作区
- 依据：[SID#1.1.DESIGN](DESIGN.md)、[SID#README](../../README.md)、[开发操作补充](AGENT-DESIGN.md)
- 核对范围：仓库文档、配置和源码；未启动服务、运行迁移、构建产物或操作云资源，也未重新验收本机与生产设施

## 实现对应

| 约定 | 当前入口与结果 |
| --- | --- |
| 开发启动与停止 | [cli.ts](../../../scripts/dev/cli.ts)、[database.ts](../../../scripts/dev/database.ts)、[dev-bootstrap.ts](../../../scripts/migration/dev-bootstrap.ts)先检查端口、准备数据库，再启动通道和应用。无表时执行基线及后续迁移。已有表时查询迁移状态，有待办时提示，查询失败时退出。`pnpm dev:stop` 停止 Docker 依赖 |
| 隧道准备和探测 | [frp.ts](../../../scripts/dev/frp.ts)、[auth-config.ts](../../../scripts/dev/auth-config.ts)区分配置验证、公网拒绝探针与真实授权验收；[esa-notice.ts](../../../scripts/dev/esa-notice.ts)独立运行只读提示 |
| 环境与配置 | [environment.mjs](../../../config/lib/environment.mjs)在业务导入前选环境；[loader.ts](../../../config/lib/loader.ts)按层合并并校验；[build.ts](../../../scripts/env/build.ts)保留目标 env 已有值 |
| 密文与 hooks | [gpg.ts](../../../scripts/env/gpg.ts)执行加解密与字节比较；[package.json](../../../package.json)把暂存密文接入 `env:check` |
| 迁移编写与冻结 | [基线清单](../../../scripts/migration/baseline.ts)保存基线覆盖的历史 SQL 和退役入口摘要。[冻结测试](../../../scripts/migration/frozen.test.ts)另登记当前基线、后续 SQL 和 TS 产物摘要。执行声明、检查点与产物构建见[开发补充](AGENT-DESIGN.md#编写数据库迁移) |
| 本机 HTTPS 证书 | [cert.ts](../../../scripts/dev/cert.ts) 生成开发 CA 与 `localhost` 证书，写入用户数据目录并同步到 Git 忽略的 `.dev/https/`；`--install` 信任当前用户（Windows `certutil`、macOS `security`、Linux Chromium NSS），`--rotate` 备份旧证书、换新身份，并在 EMQX 运行中自动重建容器。证书只在本机生成，不随仓库分发 |

本次未发现上述源码与 SID#1.1.DESIGN 的实质冲突。工作区中的空库初始化及相关测试尚未随本基线提交，不将源码核对写成已部署或已执行验收。

## 旧章节迁移对照

这里只标记已落入 SID#1.1 的内容；其他主题的资料即使已有概要，也须核对所属文档后再清理。文档收尾已删除本阶段 TMP，旧手册保留初配、领域和历史记录；统一结果见 [流程整理记录](../../AGENT.md#流程草稿与索引退役记录)。

| 旧来源／章节 | 新位置或归属 | 旧文件仍需保留的内容 |
| --- | --- | --- |
| 本地开发（`docs-legacy/development/README.md`）的环境、首次启动、启停与进程归属 | 初次准备归 SID#1.0；日常规则在 DESIGN；端口、进程、ESA 提示在 AGENT-DESIGN 前两节 | 日常操作已改链接；保留 frpc 初配细节及 EMQX 原始验收记录，EMQX 操作与样本重置已由 SID#1.4 承接 |
| 授权隧道（`docs-legacy/development/auth-tunnel.md`）的本机准备、验收与实现边界 | AGENT-DESIGN「授权隧道与 ESA 提示」 | frps `allowPorts` 与 Nginx／OpenResty 示例已在 SID#1.0「FRP 服务端配置」 |
| 配置填写（`docs-legacy/deployment/configuration.md`）的生成文件、核对交付、运行时选择 | DESIGN 的模板规则；AGENT-DESIGN「配置实际从哪里来」「生产密文与提交钩子」 | 各服务取值来源和初次填写表仍供 SID#1.0 参考 |
| 配置参考（`docs-legacy/deployment/configuration-reference.md`）的覆盖规则、环境选择、公开边界 | AGENT-DESIGN「配置实际从哪里来」 | 连接凭据和字段用途在 SID#1.0；后台与容量默认值由各领域 AGENT-DESIGN 承接，旧表的 ESA TTL 和 AVIF 项已过时 |
| 命令与脚本（`docs-legacy/development/commands.md`）的开发／env 入口和实现边界 | DESIGN 及 AGENT-DESIGN；开发进程脚本的整理见下表 | 跨主题脚本清单、其他工具与历史整理记录仍保留，不能以本次开发迁移替代全表 |
| 迁移手册（`docs-legacy/operations/migrations.md`）的版本身份、在线声明、新 TS 约定、退出方案通则 | AGENT-DESIGN「编写数据库迁移」 | 具体执行恢复归 SID#1.4；仍有效的 WebP 回执和切换明细表退出条件已迁入 SID#1.4「迁移明细归档与退役」，其余是历史 |
| 原 1.1 `TMP-DESIGN.md` | 日常与 Git 内容已由 DESIGN 覆盖，初次准备已由 SID#1.0 覆盖 | 无独有待迁内容，已删除并清理引用 |

## 待办与可选整理

| 事项 | 现状与完成条件 |
| --- | --- |
| 开发进程脚本统一 TypeScript | 已完成。[子进程管理](../../../scripts/dev/process.ts)合并了实现与类型声明，[隧道启动器](../../../scripts/dev/frp.ts)通过 `node --import tsx` 启动独立的[授权代理](../../../scripts/dev/auth-proxy.ts)子进程。 |
| 初次配置资料交接 | 已完成。隧道服务器示例、连接字段和配置填写见[初次配置](../0_setup/AGENT-DESIGN.md)，旧手册原文保存在 tag `docs-legacy-final` |
| 外部实际状态 | 本次未复验本机 frpc、云端 ESA 活动版本、生产密文口令、GitHub Secrets 或分支保护；实际接入／交付时按对应流程检查 |

## 落实与验证

2026-11-19 核对初次配置资料的现行入口与存档位置。草稿验证脚本的五处 `create_draft` 调用已传入与正文夹具一致的日期，`pnpm exec tsc --project scripts/tsconfig.json --noEmit` 通过。

2026-11-19 统一开发进程与授权代理脚本后，`pnpm exec vitest run scripts/dev/process.test.ts scripts/dev/cli.test.ts scripts/dev/auth-config.test.ts` 在允许连接本机回环端口的环境中通过 19 项测试，覆盖子进程重启、停止和取消重试。另以 `node --import tsx` 和临时端口启动授权代理，确认授权 POST 转发请求体并返回上游的状态、响应头和正文，其他方法或路径返回 404，上游离线时返回 503。

## 历史决定与工作经验

旧命令清单记录了 2026-11-01 的入口精简及 2026-11-02 的显式环境命名：删除重复别名与旧 S3 盘点，源码运维按 `:dev`／`:prod` 选择目标，共用实现；预载器继续使用原生 MJS，避免业务模块先按错误环境导入。这里继承其决定，不将当时的检查结果算作本轮验证。

`dev/tunnel.mjs` 薄包装已退休。迁移目录包含 TS 入口时，本机迁移入口按需构建冻结产物。容器入口使用镜像预构建文件。

Windows 上 GPG 优先使用 Git for Windows 的真实可执行文件，是为避开 shim 的管道挂起；排查口令时也要考虑进程变量覆盖 `.env.dev`。涉及冻结迁移时保留文件原始字节，不用可能改变编码或行尾的文本重定向修复。
