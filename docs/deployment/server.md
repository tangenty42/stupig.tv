# 服务端与反向代理

生产事实源：[Compose](../../docker-compose.yml)、[Dockerfile](../../Dockerfile)、[入口脚本](../../docker-entrypoint.sh)、[健康端点](../../server/routes/healthz.get.ts)。当前 Compose 接入已经存在的外部 Docker 网络，应用不是在生产宿主机直接执行 `pnpm dev`。

## 主机准备

1. 安装 Docker 与 Compose 插件，建立可由部署用户写入的 `DEPLOY_DIR`。
2. 准备 MySQL、Redis、EMQX 的持久化与备份，连接到供应用使用的 Docker 网络。将网络实际名称填写为 `EXTERNAL_DOCKER_NETWORK`；Compose 不会创建 external 网络。
3. 用容器网络地址填写 `MYSQL_HOST`、`REDIS_HOST`、`MQTT_HOST`。应用容器中的 `127.0.0.1` 指应用自己，不是数据库或宿主机。
4. 准备 OpenResty/Nginx 与 TLS。应用固定容器名为 `stupig-tv`，宿主机映射只有 `127.0.0.1:${APP_PORT}`，外部入口交给反代。
5. 配置 [GitHub/ACR](github-acr.md) 与生产 env；禁用旧 `cleanup --delete` cron。后台任务随应用运行时不要再启动旧任务执行器。

当前部署采用与 1Panel 共用的外部网络。若 OpenResty 在宿主机，回源到宿主机回环端口；若 OpenResty 也在容器内，需接入同一网络并用 `stupig-tv:<APP_PORT>`，不能在那个容器里使用 `127.0.0.1:<APP_PORT>` 找应用。

## 主站反代

以下是需要合并到现有站点的最小结构示例，域名、证书和 upstream 地址须换成该主机实际值；不是本轮从线上导出的配置。

```nginx
location / {
    proxy_pass http://127.0.0.1:3042;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 2m;
}
```

3042 仅为仓库默认应用端口，与 `APP_PORT` 一起核对。2 MiB 是已有网关建议值，发布前要核对允许提交的正文和批量元数据大小；若业务上限更大，应协调网关上限，不能让网关拒绝应用允许的请求。附件分片通过预签名 PUT 直接进入 OSS，不经过主站正文网关。

不要给 tRPC、登录、Content 授权回调套静态缓存。保留 Cookie、POST 请求体、请求方法及必要响应头。不要将数据库、Redis、EMQX Dashboard 或发布 TCP 端口暴露到公网。开发 Compose 对部分依赖使用宿主机端口映射，不是可直接复制的生产编排。

## Content 授权回调

回调为应用的 `POST /api/content/authorize`，ESA 函数请求它获取当前读取决定。正常授权返回 204 并携带 `X-Content-Authorization`，拒绝返回 403；其它异常在 ESA 端按失败关闭处理。

生产可给现有应用配置独立 HTTPS 入口，或使用与 Content 读取域名不同源的主站入口。必须保持 POST JSON 与证明响应头，不重定向至登录页，不加需要浏览器交互的挑战，不缓存授权结果。该地址记录在 ESA 函数的 `CONTENT_AUTH_URL`，不是单靠修改 YAML 就能上线。

开发使用 frp 的限路径代理，生产回调不依赖开发机。详见[边缘函数](esa-functions.md)和[开发隧道](../development/auth-tunnel.md)。

## 启动与维护

生产容器默认先执行：

```sh
node .output/server/maintenance/migrate.mjs
```

成功后用 `exec` 启动 `.output/server/index.mjs`。遇到尚未执行的 maintenance 迁移会停止，不能通过反复重启绕过。首次空库或旧 Content 升级应先停止写入，用同镜像、同 env 和同网络的一次性容器执行[维护迁移](../operations/migrations.md)。

默认 `app.backgroundRunner.mode: app`，图片、上传生命周期、退役/刷新、预热、通知由应用内统一 runner 调度。源码工作区可切成 worker 模式并运行 `pnpm background:worker`，但当前生产 Compose 没有 worker 服务，maintenance 构建也只打包 migrate/cleanup，没有 worker 或 status CLI 产物；生产精简镜像不含 tsx。因而不能仅切换生产 YAML 就期待独立 worker 启动：需要先补齐独立进程的打包/编排并验收。现有生产交付保持 app 模式，机制见[后台任务](../modules/background-jobs.md)。

## 健康、日志与退出

```sh
docker compose --env-file .env.prod ps
docker compose --env-file .env.prod logs --tail 100 app
curl --fail http://127.0.0.1:3042/healthz
```

容器探针每 30 秒检查一次，超时 5 秒，连续失败 3 次判不健康，启动宽限 120 秒。部署脚本另有健康门，见 [GitHub/ACR](github-acr.md)。`restart: unless-stopped` 能处理进程退出；仅 unhealthy 而进程未退出，并不等于 Docker 会自动重启它。

停止时 Node 收到信号，runner 停止认领新工作并等待当前检查点。默认应用内收尾预算 30 秒；生产 Compose 显式设置 `stop_grace_period: 45s`，覆盖该预算。使用其它编排时也应保留足够的退出宽限。

日志重点看配置校验、迁移冻结校验、数据库连接、MQTT 发布、runner 扫描失败和对象账本状态。不要在反代访问日志或故障报告中保存完整签名 URL、Authorization 或凭据。备份/恢复与长期监控见[运维](../operations/backup-recovery.md)。
