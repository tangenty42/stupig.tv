# About

This is the repository for our official website, built with our custom Markdown-powered full-stack CMS.

We are the smart **Stupig**s!

Learn more about us at our official website [stupig.tv](https://www.stupig.tv).

# Local development

Dependencies (MySQL, Redis, EMQX, phpMyAdmin) run in Docker via `docker-compose.dev.yml`;
the Nuxt dev server runs on the host and reads the same `.env`.

```sh
pnpm env:build:dev     # creates/rebuilds .env from shared + dev; existing values are
                       # preserved, and new <required> keys prompt for a value (Enter skips)
pnpm install
pnpm dev:all           # start the dependency services, then run the dev server
```

`pnpm env:build:dev` also prompts for `ENV_PASSPHRASE` once and stores it in the
gitignored local `.env`; `pnpm env:check`, `pnpm env:encrypt` and the pre-commit check
read it there automatically. An explicitly supplied value or process environment
variable takes precedence. This local-only key is not included in `.env.prod` or sent to
the server.

- `pnpm dev:services` — start the dependency services only
  (`docker compose -f docker-compose.dev.yml up -d`; safe to re-run)
- `pnpm dev` — run the dev server only, with the dependency services already up
- `docker compose -f docker-compose.dev.yml down` — stop the dependency services
  (add `-v` to also drop the MySQL volume)

Deployment credentials and YAML-referenced connection values come from `.env` or `.env.prod`,
rebuilt from the shared template and the selected environment template:
[`.env.shared.layer`](.env.shared.layer) plus [`.env.dev.layer`](.env.dev.layer) for
`pnpm env:build:dev`, or [`.env.prod.layer`](.env.prod.layer) for
`pnpm env:build:prod`. The command without an explicit environment requires `NODE_ENV`.
Existing values are preserved; keys found in neither the shared nor either environment
template stay in a marked local-only section at the end.

# Configuration

- Stable application parameters live in [config/app-settings.yaml](config/app-settings.yaml).
  [config/lib/schema.ts](config/lib/schema.ts) validates their shape and relationships.
  This file does not use environment interpolation or environment-specific overrides.
  [config/lib/generate.ts](config/lib/generate.ts) validates it, serializes the result into
  [server/shared/settings.generated.ts](server/shared/settings.generated.ts), and formats
  the TypeScript with ESLint. Identical output is not rewritten. Both server and browser
  import the generated value through `@shared/settings`; do not edit the generated file.
  YAML uses block mappings and sequences and must end with a newline, enforced by ESLint.
- Server configuration loads `config/default.yaml`, then `{NODE_ENV}.yaml`, then optional
  `config/local.yaml` in development. Mapping nodes merge recursively; arrays replace.
  Environment variables are read only where YAML explicitly references `${VAR}` or
  `${VAR:-fallback}`. The merged and interpolated result is validated in
  [config/lib/loader.ts](config/lib/loader.ts), using the schemas in `config/lib/schema.ts`.
- Server code imports deployment configuration from `@config/lib/loader`.
  `load_config()` recursively merges validated app settings with validated deployment
  configuration, preserving their YAML keys and nesting. For example, stable MQTT
  parameters remain under `integrations.mqtt`, connection details under `mqtt`, and
  browser preferences under `app.client`. `AppConfig` is inferred from this composition.
  `runtime_config()` loads the result once and caches it for the lifetime of the process;
  importing the loader alone does not load configuration or generate shared settings.
  The browser-visible subset is `public_config_schema` in `config/lib/schema.ts`, built
  from the deployment schemas; Nitro injects it into `runtimeConfig.public` at startup.
  Settings types are inferred from Zod and exported as `Settings` by the loader and shared
  facade. Use `import type` for these types: browsers must not import the server loader,
  filesystem APIs, environment credentials, or YAML parser at runtime.
- [.env.shared.layer](.env.shared.layer) documents the secrets; the environment
  templates document the host/URL differences. Existing process environment values take
  precedence over `.env`; secrets stay server-side. Nitro injects only the validated
  public subset into `runtimeConfig.public`.
- The production image includes `config/`. Database migrations and dumps load and validate
  only the `db` subtree, so they do not require unrelated service credentials.

## Shared settings generation

| Trigger | Where it is wired |
| --- | --- |
| Nuxt initialization (`dev`, `build`, `generate`, `typecheck`, `prepare`) | `nuxt.config.ts` registers `config/lib/nuxt-module.ts`; its async `setup()` awaits generation before application compilation |
| Installation postinstall, unless scripts are disabled | `package.json` runs `nuxt prepare`, which initializes the local module |
| Development changes to `config/app-settings.yaml` | The local module registers the file watch and `builder:watch` regeneration hook in development only |
| Vitest startup | `vitest.config.ts` awaits `generate_settings()` |
| Maintenance script bundling | `pnpm maintenance:build` runs `pnpm settings:generate` first |
| Explicit generation | `pnpm settings:generate` |

Run `pnpm settings:generate` after editing app settings and commit the generated file.
`pnpm settings:check` validates YAML and checks freshness without writing files; it fails
if the generated file is missing or stale. CI also checks the generated file against Git
after installation, so automatic regeneration cannot hide uncommitted changes.
Production server startup and ordinary module imports do not generate shared settings.
Importing `nuxt.config.ts` alone also does not generate files: it reads app settings for
its configuration values but leaves generation and watching to the local Nuxt module.

Production-only values such as site indexability and the OSS bucket live in
`config/production.yaml`. Set the browser-facing MQTT URL and OTP debug switch in `.env`:

```dotenv
MQTT_WEB_URL=wss://mqtt.example.com/mqtt
NUXT_OTP_DEBUG=false
```

Existing private secret names remain unchanged. Changing environment-variable values requires
recreating the container (`docker compose up -d --force-recreate`), not rebuilding the image.
Changing only a host-side `.env` and restarting an existing container does not update its environment.
Changes to YAML require building and deploying a new image because the config directory is copied into it.
App settings changes must also regenerate and rebuild the shared module; changing only a
server-side YAML file would leave the browser's compiled settings out of sync.

# Deployment

- Wire up your MySQL and Redis instance
- The production `.env` is maintained locally as the gitignored `.env.prod`
  (`pnpm env:build:prod` merges template changes into it and prompts for new
  `<required>` keys), then encrypted to the committed `.env.prod.gpg`
  (`pnpm env:encrypt`). `pnpm env:check` decrypts the committed file and compares it
  with the local plaintext by key — it also runs as a pre-commit hook whenever
  `.env.prod.gpg` is staged, so a stale ciphertext cannot be committed unnoticed.
  The deploy workflow decrypts it with the `ENV_PASSPHRASE`
  secret and pushes it to the server; a missing file or leftover `<required>`
  placeholder aborts the deploy before touching the running container.
- Reverse-proxy your EMQX WebSocket endpoint (`http://127.0.0.1:8083/mqtt`) with SSL
  under a dedicated host like `mqtt.example.com`, then set `MQTT_WEB_URL` in `.env`
  to the full browser-facing address (e.g. `wss://mqtt.example.com/mqtt`, no port needed
  behind the reverse proxy). Nitro loads it through the YAML placeholder and injects the
  validated URL into `runtimeConfig.public`.
  Missing or invalid public deployment fields fail startup validation.
- EMQX must require authentication, otherwise anyone can publish sync events. Set
  `MQTT_USERNAME`/`MQTT_PASSWORD` to non-empty credentials in `.env`, then configure the
  broker once via its Dashboard (or REST API):
  - Access Control → Authentication → Create → `Password-Based` + `Built-in Database`,
    with `User ID Type` = `username`, then add the `MQTT_USERNAME`/`MQTT_PASSWORD` user
    under its User Management tab. This is the server-side publisher account.
  - Access Control → Authorization: mirror [emqx-acl.conf](emqx-acl.conf) — the same file
    the dev container mounts — so `server_*` client ids may publish/subscribe
    `stupig/sync/#`, `web_*` client ids (browsers) may only subscribe, and unmatched
    clients are denied (`no_match: deny`).
  - Change the Dashboard's default `admin/public` password and never expose its port,
    or the TCP listener (1883), publicly; only the reverse-proxied WebSocket port should
    be reachable from the internet.
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
  before. `.env` and `docker-compose.yml` are staged as incoming files, backed up, and
  switched together; any failure after the switch (including a health timeout) restores
  both files and the previous image, then verifies the old container. The workflow still
  fails loudly after rollback. Database migrations are forward-only and are **not** rolled
  back automatically; schema/data recovery remains a separate operational procedure.
- Add a scheduled task to run the storage cleanup: 1panel 计划任务 → 类型选「容器内执行」→
  容器 `stupig-tv` → 命令 `cd /app && node .output/server/maintenance/cleanup.mjs --delete --grace-hours=168`
  （先用不带 `--delete` 的同一命令跑一次，确认报告内容符合预期再开删）
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
