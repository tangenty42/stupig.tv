# About

This is the repository for our official website, built with our custom Markdown-powered full-stack CMS.

We are the smart **Stupig**s!

Learn more about us at our official website [stupig.tv](https://www.stupig.tv).

# Local development

Dependencies (MySQL, Redis, EMQX, phpMyAdmin) run in Docker via `docker-compose.dev.yml`;
the Nuxt dev server runs on the host and reads the same `.env`.

```sh
cp .env.example .env   # first time only: fill in the secrets, keep the local ports as-is
pnpm install
pnpm dev:all           # start the dependency services, then run the dev server
```

- `pnpm dev:services` — start the dependency services only
  (`docker compose -f docker-compose.dev.yml up -d`; safe to re-run)
- `pnpm dev` — run the dev server only, with the dependency services already up
- `docker compose -f docker-compose.dev.yml down` — stop the dependency services
  (add `-v` to also drop the MySQL volume)

Every port, host and credential comes from `.env`; start from `.env.example`.

# Deployment

- Wire up your MySQL and Redis instance
- Reverse-proxy your EMQX WebSocket endpoint (`http://127.0.0.1:8083/mqtt`) with SSL
  under a dedicated host like `mqtt.example.com`, then set `MQTT_WEB_URL` in `.env`
  to the full browser-facing address (e.g. `wss://mqtt.example.com/mqtt`, no port needed
  behind the reverse proxy). The image is built without a `.env`, so the browser value is
  derived at container start by the image's own entrypoint from `MQTT_WEB_URL` (see
  `docker-entrypoint.sh`); changing it only needs a container restart, not a rebuild. The
  server asserts at startup that the injected value matches `MQTT_WEB_URL` (see
  `server/plugins/public-config-guard.ts`), so a missing or mismatched injection keeps the
  container down instead of silently handing the browser an empty broker URL
- Migrations under `migrations/` are applied automatically when the container starts
  (the `CMD` runs the bundled runner before the server; a failure keeps the container down
  on purpose). Existing databases whose schema was built by hand need a one-off
  `docker exec stupig-tv node .output/server/maintenance/migrate.mjs --baseline`;
  `--status` is read-only and lists what is pending
- Health and self-healing: the image ships a `HEALTHCHECK` (and `docker-compose.yml`
  an equivalent one) probing `/healthz`, which asks the database and the migration
  ledger — a 200 on `/` would prove neither. CD ships `docker-compose.yml` from the repo
  to the server before `docker compose pull` (the previous copy is kept as
  `docker-compose.yml.bak`), so that file is the single source of truth and editing it
  on the server gets overwritten by the next deploy. CD then runs
  `scripts/deploy-remote.sh`, which waits for the container to become healthy: if it
  exits or enters a restart loop the deploy rolls back to the image that was running
  before, and either way the workflow fails loudly instead of reporting a green deploy
  over a dead site. A container that is merely slow (still running, not yet healthy)
  does *not* trigger a rollback — only the logs and a red run.
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
