# AGENT：初次配置记录与旧资料去向

- 本文档状态：DONE（初配资料及历史记录已承接，外部衔接项按原计划处理）
- 覆盖范围：初配资料来源、带日期的云端读回及验证边界
- 文档整理基线：2026-11-11 20:55:43 +08:00（Asia/Shanghai），提交 722c1cd3392cb4cdb5c8b051f3354c8e3905e355 及工作区
- 操作入口：[SID#1.0.AGENT-DESIGN](AGENT-DESIGN.md)

本轮整理文档与本地源码配置。下文云端状态保留 2026-11-09 原记录及范围，后续发布、盘点或恢复时核对实际目标。

## 开发桶跨域待办

- [ ] 开发桶管理员将 `stupig-static-dev` 的 CORS 来源从 `http://localhost:3042` 更新为 `https://localhost:3042`。2026-11-21 从新来源对开发桶发起的 `PUT` 预检返回 403。更新后在 HTTPS 编辑页上传一个附件，确认预检允许新来源和 `PUT`、分片响应能读取 `ETag`，并完成上传。

## 2026-11-09 复核与待办

- **RAM 和 OSS（01:15:19 起复核）。** 9 份策略权限语义与仓库一致；10 个项目用户的直接绑定符合记录，均无用户组。2026-11-09 01:37:23 起（Asia/Shanghai）补充读回确认，两名 OSS 应用用户的专项盘点策略均已解绑：`stupig-oss-dev` 仅保留 `stupig-oss-app-dev-access`（v5），`stupig-oss-prod` 仅保留 `stupig-oss-app-prod-access`（v4），两者均无用户组。两个桶均为私有，启用了版本控制和阻止公共访问，CORS 覆盖对应页面与上传所需请求头。生命周期规则已配置：非当前版本满 7 天清理、过期删除标记清理、未完成分片上传初始化满 7 天自动终止。[云端配置复核记录](../../../config/ram/CLOUD-AUDIT-2026-11-09.md)
- **ESA 交付规则。** 已读回两条代理 DNS 和同账号私有 OSS 源站。两个 Content 路由均为自定义、启用、Bypass 开、Fallback 关。缓存、HTTPS／Range 回源、清空回源 query、出站响应头和动态文件名规则均已启用并覆盖两个 Content host。两函数超时均为 5000 ms，鉴权变量均为 `secret_text`，读取只确认存在和类型。
- **ESA 站点全局安全与协议配置（01:15:19 起复核）。** 强制 HTTPS 开启。TLS 1.0 和 1.1 关闭，1.2 和 1.3 开启；加密套件组为 `strict`。HSTS 开启，`max-age=15552000`（180 天），不包含子域，不启用 preload。源站证书校验 `OriginVerify=on`，回源双向认证 `OriginMtls=on`。HTTP/2、HTTP/3、HTTP/2 回源全部开启。OCSP Stapling 关闭。WebSocket 开启，IPv6 关闭。分层缓存 `edge_regional`。查询的 8 类站点 WAF 规则集为空，智能限频关闭；此结果不能推断平台默认防护或账号级防护全部关闭。[规则集查询范围](https://help.aliyun.com/zh/edge-security-acceleration/esa/api-esa-2024-09-10-listwafrulesets)
- **生产回调与部署衔接。** 云端生产回调仍为 `https://www.stupig.tv/api/content/authorize`，仓库 [prod.yaml](../../../config/prod.yaml) 配置为 `/api/hooks/esa/authorize`。用户已确认留到下次部署处理。开发回调与仓库一致。
- **ACR 和 GitHub。** ACR 仓库读回为广州 `tangenty42/stupig-tv`，私有、状态正常。GitHub `main` 的有效规则要求 GitHub Actions 的 `check`，并要求合并前分支为最新。
- **验证边界。** 本轮只读核对基线为 2026-11-09 01:15:19 起（Asia/Shanghai），两名 OSS 用户的直接策略及用户组于 01:37:23 起补充读回，使用 `.env.tmp` 密钥，未修改云端配置。本轮没有重新验收实际上传下载、冷回源、HEAD／Range、回调授权、生产清扫任务、GitHub、ACR、短信及生产健康接口。PNVS 的签名、模板、方案和图形验证域名白名单以产品控制台为准。生产主机内的反代、数据库、容器网络与实际部署凭据，以及 GitHub Secrets 的可用性，按对应步骤和业务验收确认。[号码认证 OpenAPI](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-overview)

## 旧资料去向

| 旧材料 | 本次承接 |
| --- | --- |
| development/auth-tunnel 的服务端配置 | 初配补充的 FRP 配置与反代样例，保留控制连接、限路径回调及端口网络要求 |
| deployment/server 的主机与反代 | 初配补充的生产网络、主站反代及授权回调 |
| deployment/mqtt 的 WSS 入口 | 初配补充的公开和草稿两路反代，协议与历史切换记录继续保留旧材料 |
| deployment/configuration、configuration-reference | 初配字段表与环境 YAML，底层加载、业务时序和容量配置保留旧参考 |
| deployment/github-acr 的仓库与 SSH 设置 | 初配补充的 Repository 配置表与 known_hosts 格式，带日期发布证据仍留原文件 |
