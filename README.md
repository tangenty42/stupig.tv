# About

This is the repository for our official website, built with our custom Markdown-powered full-stack CMS.

We are the smart **Stupig**s!

Learn more about us at our official website [stupig.tv](https://www.stupig.tv).

# Deployment

- Wire up your MySQL and Redis instance
- Reverse-proxy your EMQX WebSocket endpoint (`http://127.0.0.1:8083/mqtt`) with SSL
  under a dedicated host like `mqtt.example.com`, then set `MQTT_WEB_URL` in `.env`
  to the full browser-facing address (e.g. `wss://mqtt.example.com/mqtt`, no port needed
  behind the reverse proxy). The image is built without a `.env`, so the browser value
  is injected at container start via `NUXT_PUBLIC_MQTT_WEB_URL` (`docker-compose.yml`);
  changing it only needs a container restart, not a rebuild
- Migrations under `migrations/` are applied automatically when the container starts
  (the `CMD` runs the bundled runner before the server; a failure keeps the container down
  on purpose). Existing databases whose schema was built by hand need a one-off
  `docker exec stupig-tv node .output/server/maintenance/migrate.mjs --baseline`;
  `--status` is read-only and lists what is pending
- Add a scheduled task to run the storage cleanup: 1panel 计划任务 → 类型选「容器内执行」→
  容器 `stupig-tv` → 命令 `cd /app && node .output/server/maintenance/cleanup.mjs --delete --grace-hours=168`
  （`cd /app` 不能省：配置加载以 cwd 为基准找 `config/*.yaml`。先用不带 `--delete`
  的同一命令跑一次，确认报告内容符合预期再开删）
- Set `client_max_body_size 2m;` for your gateway safety

# This is why you should always update your VSCode without reading the changelog

`POV: you click "update" in your VSCode as usual.`

the following 2 hrs:

![0](public/md/vscode/0a.png)
![0](public/md/vscode/0b.png)
![0](public/md/vscode/0c.png)

occasionally:

![1](public/md/vscode/1.png)

you:

![2](public/md/vscode/2.png)
