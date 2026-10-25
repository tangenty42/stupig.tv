---
description: "Use when creating or editing tRPC routers, Nitro routes, services or server infrastructure."
name: "Backend API Conventions"
applyTo: "server/**/*.ts"
---

# Backend rules

## Boundaries and types

- Add operations to domain routers in `server/trpc/routers/`, composed by `server/trpc/router.ts`. The Nitro tRPC route is a transport adapter only.
- Procedures use the appropriate public/protected/admin procedure, validate with Zod, call services and return data. Throw `ApiError` for expected failures; preserve Chinese user-facing messages and transport status. Do not return raw exceptions.
- Keep business DB queries in `server/services/`. `server/lib/` contains low-level integrations; services orchestrate them, procedures do not bypass services, and lib must not depend on services.
- Use `@server` aliases. Public API payloads/responses and sync identifiers belong in `server/shared/types/` (`@shared/types/*`). Server-only auth/JWT types stay in `server/types/`; private service types stay beside their owner.
- Full tRPC schemas live in `server/trpc/schemas.ts`; compose frontend form contracts from `server/shared/schemas.ts` rather than duplicating them.
- Keep shared modules browser-safe. Use `@config/loader` only server-side; scoped tools load only their required configuration subtrees. See [configuration](../../docs/deployment/configuration.md).

## Authorization and data

- For supported admin delegation, accept `operate_for` and call `resolve_operate_target`; do not create a second profile API unless the contract genuinely differs.
- Reuse `select_profile_row_sql` and `format_profile_row()` for user reads, including phone visibility. Derive login/seen/online values from `user_login_sessions`; never restore removed activity/session-version columns on `users`.
- MySQL connections use UTC. Store UTC timestamps, convert boolean `tinyint(1)` values before returning, and use project time helpers for presentation.
- Authorize at operation and publication boundaries. UI disabled states and browser grants do not replace server checks. Preserve path reservations, version checks and transaction boundaries described in [Content workspace](../../docs/modules/content/workspace.md).
- Content mutations enqueue precise invalidations on the same transaction connection (`enqueue_workspace_change` / `enqueue_content_refresh`). Other domains publish through `server/lib/sync.ts`. See [realtime](../../docs/modules/realtime.md).
- Keep background leases, checkpoints and external-effect receipts in their owning domains. The shared runner schedules bounded scans; do not treat its resource slots as cluster-wide exclusion. See [background jobs](../../docs/modules/background-jobs.md).

## Verification

- Cover service validation, thrown status/message and row/object/notification side effects. Mock infrastructure boundaries, never the service under test; a transaction connection needs its own `execute` mock.
- Follow [testing](../../docs/development/testing.md); run typecheck after type/import changes. Preserve migration immutability even when a historical helper resembles current runtime code.
