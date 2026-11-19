# 开发授权回调隧道

> 隧道启动与排查见 [SID#1.1.AGENT-DESIGN](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#授权隧道与-esa-提示)，frps／反代完整示例见 [SID#1.0.AGENT-DESIGN](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#frp-服务端配置)。本文保留连接图、实现边界及原章节入口。

ESA 在交付 Content 对象前调用应用授权接口。开发应用在本机，因此使用 frp 暴露一个仅允许授权 POST 的专用代理；主站其他 API 不通过此隧道公开。

## 连接关系

当前仓库开发配置来自 [config/dev.yaml](../../config/dev.yaml) 的 `devAuthTunnel`；回调地址统一读取 `esaFunction.callbackUrl`：

```text
frpc ── WSS :443 ── frps-service.cina.cs.tangenty.com ── 反代 ── frps:7000

ESA ── HTTPS ── stupig-content-auth-dev.cina.cs.tangenty.com
    ── 反代 ── frps:15550 ── frpc ── 127.0.0.1:55500
    ── POST /api/hooks/esa/authorize ── 127.0.0.1:APP_PORT
```

| 地址／端口 | 用途 |
| --- | --- |
| frps 连接域名的 443 | frpc 经 HTTPS 反代建立 WSS 控制连接 |
| frps 内部 7000 | `bindPort`，不是管理面板端口 |
| frps 15550 | 本代理的 `remotePort`，供授权回调反代访问 |
| 本机 55500 | 授权专用代理 |
| 本机 `APP_PORT` | Nuxt，模板当前为 3042 |

## 本机准备

安装官方 frpc 0.71.0，与现有服务端版本一致。仓库不自动下载二进制；默认 Windows 路径为 `.dev/tools/frp_0.71.0_windows_amd64/frpc.exe`，其他位置通过自行创建的 `config/local.yaml` 覆盖。该文件是未入库的可选本机配置，见[配置说明](../deployment/configuration.md)。

首次填写 token、回调与启动顺序见 [SID#1.0 的开发回调配置](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#6-连上开发回调并启动)。`prepare`／`verify` 的区别、日常启动和诊断见 [SID#1.1 的授权隧道与 ESA 提示](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#授权隧道与-esa-提示)。

## 服务端配置

frps 端口、控制连接和限路径回调的完整配置见 [SID#1.0 的 FRP 服务端配置](../../docs/1_workflows/0_setup/AGENT-DESIGN.md#frp-服务端配置)。

## 验收与 ESA 更新

通道探针与真实读取验收见 [SID#1.1 的授权隧道与 ESA 提示](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#授权隧道与-esa-提示)，发布命令及结果核对见 [SID#1.3 的单独发布 ESA](../../docs/1_workflows/3_deliver/AGENT-DESIGN.md#单独发布-esa)。

首次接入时，按 [ESA 函数发布](../deployment/esa-functions.md)更新 `CONTENT_AUTH_URL`，保存变量快照并发布明确版本；用应用签发的真实读取 grant 验证授权成功及 HMAC。固定域名与进程存活不保证公网持续可达。

## 实现边界

通道配置只由 [auth-config.ts](../../scripts/dev/auth-config.ts) 读取，不进入应用公共配置。仅运行 `dev:app` 不需要 token；真实 ESA 读取仍依赖有效的外部回调。进程归属、端口冲突与 Ctrl+C 处理见 [SID#1.1 的开发进程与端口](../../docs/1_workflows/1_develop/AGENT-DESIGN.md#开发进程与端口)，其他故障诊断见 [SID#1.4](../../docs/1_workflows/4_maintain/AGENT-DESIGN.md#故障排查)。
