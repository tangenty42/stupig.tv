# 开发授权回调隧道

ESA 在交付 Content 对象前调用应用授权接口。开发应用在本机，因此使用 frp 暴露一个仅允许授权 POST 的专用代理；主站其他 API 不通过此隧道公开。

## 连接关系

当前仓库开发配置来自 [config/dev.yaml](../../config/dev.yaml) 的 `devAuthTunnel`；回调地址统一读取 `esaFunction.callbackUrl`：

```text
frpc ── WSS :443 ── frps-service.cina.cs.tangenty.com ── 反代 ── frps:7000

ESA ── HTTPS ── stupig-content-auth-dev.cina.cs.tangenty.com
    ── 反代 ── frps:15550 ── frpc ── 127.0.0.1:55500
    ── POST /api/content/authorize ── 127.0.0.1:APP_PORT
```

| 地址／端口 | 用途 |
| --- | --- |
| frps 连接域名的 443 | frpc 经 HTTPS 反代建立 WSS 控制连接 |
| frps 内部 7000 | `bindPort`，不是管理面板端口 |
| frps 15550 | 本代理的 `remotePort`，供授权回调反代访问 |
| 本机 55500 | 授权专用代理 |
| 本机 `APP_PORT` | Nuxt，模板当前为 3042 |

这两个公网域名不能互换。`esaFunction.callbackUrl` 包含完整 `/api/content/authorize` 路径；修改后运行 `pnpm esa:deploy:dev` 才同步变量并发布到 ESA。

## 本机准备

1. 安装官方 frpc 0.71.0，与现有服务端版本一致。仓库不自动下载二进制；默认 Windows 路径为 `.dev/tools/frp_0.71.0_windows_amd64/frpc.exe`，其他位置通过 `config/local.yaml` 覆盖。
2. 在本机 `.env.dev` 配置 `DEV_FRP_TOKEN`，对应服务器已有 token。只将变量引用写入 YAML。
3. 运行下列配置检查：

```sh
pnpm env:build:dev
pnpm dev:auth:prepare
pnpm dev:auth:verify
```

`prepare` 生成忽略目录中的 `.dev/auth/frpc.json` 与公共 CA bundle。token 不写入生成 JSON，而是启动时通过子进程环境中的 JSON 编码模板传给 frpc。`verify` 检查可执行文件版本并运行 frpc 原生配置验证，尚未连接服务器。

默认使用 `pnpm dev` 同时启动应用和通道。已有独立应用时才运行 `pnpm dev:tunnel`。启动器重试意外退出的 frpc，并周期性探测回调；不会自动修改 DNS、服务器反代或发布 ESA。

## 服务端配置

修改现有 frps 部署，保留其他代理、token 和端口。若已经配置 `allowPorts`，把本代理端口追加到原数组；不能用单条配置覆盖其他项目：

```toml
allowPorts = [
  # 保留已有项
  { single = 15550 }
]
```

`bindPort` 与代理监听地址分别由 frps 的 `bindPort`、`proxyBindAddr` 控制，详见 [frp 服务端配置](https://gofrp.org/en/docs/reference/server-configures/)。宿主机反代可映射 `127.0.0.1:15550:15550`；同一 Docker 网络中的反代使用实际服务名，例如 `http://frps:15550`。不要把反代容器的 `127.0.0.1` 当作另一个容器。

WSS 连接域名需要把 WebSocket Upgrade 转给 frps 的 7000；授权回调域名则转到本代理的 15550。TLS 在入口终止。回调路由不缓存响应，也不能绕回 ESA 的附件路由造成循环。

下面是授权 HTTPS 站点的 Nginx/OpenResty location 示例；证书和站点声明沿用现有部署管理方式，`proxy_pass` 按容器拓扑调整：

```nginx
location = /api/content/authorize {
    limit_except POST { deny all; }
    client_max_body_size 8k;
    proxy_pass http://127.0.0.1:15550;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_connect_timeout 3s;
    proxy_read_timeout 5s;
    proxy_cache off;
    proxy_buffering off;
}

location / {
    return 404;
}
```

代理与应用还有各自的正文和签名校验。不要在反代日志中记录请求正文，其中可能含有仍有效的读取凭据。frp 的原生配置格式及环境模板见[官方说明](https://gofrp.org/en/docs/features/common/configure/)。

## 验收与 ESA 更新

1. `verify` 通过，启动后确认 frpc 登录及代理注册成功。
2. 本机代理与公网根路径返回 404；空 JSON 授权 POST 返回 403，且开发代理响应含 `X-Dev-Auth-Proxy: 1`。
3. 用应用签发的真实读取 grant 验证授权成功及 HMAC。不要将 grant、签名 URL 或 token 写进共享日志。
4. 按 [ESA 函数发布](../deployment/esa-functions.md)更新 `CONTENT_AUTH_URL`，保存变量快照并发布明确版本。
5. 验证 ESA GET、HEAD、Range、完整下载摘要及拒绝场景；再测试缓存 HIT 后撤权和回调不可达时的拒绝。

空请求探针显示 `callback reachable` 不是业务验收通过。根路径 `Not Found` 在此设计中是正常响应，也不能据此证明授权可用。固定域名与进程存活不保证公网持续可达。

## 实现边界

通道配置只由 [auth-config.ts](../../scripts/dev/auth-config.ts) 读取，不进入应用公共配置。仅运行 `dev:app` 不需要 token；真实 ESA 读取仍依赖有效的外部回调。进程归属、端口冲突与 Ctrl+C 处理见[开发启动说明](./README.md)，故障诊断见[排查手册](../operations/troubleshooting.md)。
