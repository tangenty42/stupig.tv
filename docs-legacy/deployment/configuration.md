# 填写开发与生产配置

> 初次填写与字段表见 [SID#1.0](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#初配字段与反代示例)，环境文件合成、覆盖规则和密文操作见 [SID#1.1.AGENT-DESIGN](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#配置实际从哪里来)。本文保留原章节入口及交付补充。

全部字段和默认值按需查[配置项参考](configuration-reference.md)，不用先通读。

## 1. 生成文件

首次生成环境文件见 [SID#1.0 的本机准备](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#1-准备本机)，重建模板、沿用旧值和必需变量的规则见 [SID#1.1.DESIGN](../../docs/1_workflows/1_develop/DESIGN.md#改东西)。生成后按下表补齐服务配置。

## 2. 按表填写

连接与凭据、环境 YAML 及身份来源统一见 [SID#1.0 的初配字段](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#初配字段与反代示例)。

## 3. 核对并交付

目标预检和 ESA 发布见 [SID#1.3 的单独发布 ESA](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#单独发布-esa)；密文生成、校验与口令轮换见 [SID#1.1 的生产密文与提交钩子](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#生产密文与提交钩子)。

提交 YAML、必要模板和 `.env.prod.gpg`；GitHub `ENV_PASSPHRASE` 与本机加密口令一致，两者不一致期间的生产部署会在解密阶段失败。口令应由密码管理器生成高熵随机值。[GPG 实现](../../scripts/env/gpg.ts)的迭代加盐 S2K count 固定为 65011712。

## 运行时选哪个文件

日常命令的环境选择、进程变量优先级和 Compose 的 `--env-file` 规则统一见 [SID#1.1 的配置来源](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#配置实际从哪里来)，底层预载和 Nuxt 的 `--dotenv` 接线见[配置项参考](configuration-reference.md#环境文件选择)。
