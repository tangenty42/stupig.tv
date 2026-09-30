---
description: "Use when creating or editing tRPC routers, Nitro transport routes, services, or server-side code in this Nuxt project."
name: "Backend API Conventions"
applyTo: "server/**/*.ts"
---

# Backend API Guidelines

- Add application operations to a domain router in `server/trpc/routers/` and merge it through `server/trpc/router.ts`. Keep `server/api/trpc/[trpc].ts` as a transport-only adapter.
- Procedures validate input with Zod, delegate to services, and return data directly. Use `public_procedure`, `protected_procedure`, or `admin_procedure` from `server/trpc/init.ts` as appropriate.
- Throw `ApiError` for failures; do not return raw errors to the client.
- Keep DB access in `server/services/`. Avoid direct DB queries in procedures and transport routes.
- Server code should use the `@server` alias.
- `server/lib/` holds low-level, stateless infrastructure and external integrations (e.g., `db.ts`, `mqtt.ts`, `session.ts`, `sms.ts`, `captcha.ts`, `sync.ts`). Services orchestrate `lib`; procedures should not call `lib` directly for business operations. `lib` should not depend on `services`.
- **Type placement rules:**
  - Public API-facing payload and response types go in `server/shared/types/` and are exposed to both client and server through the `@shared/types/*` alias. Shared sync event and resource identifiers also belong here. Examples: `user.ts`, `session.ts`, `otp.ts`, `sync.ts`, `api.ts` (barrel re-export).
  - Server-only types (JWT payload, `AuthUser`, internal auth input types) stay in `server/types/`. Example: `auth.ts`.
  - Internal service-specific types (e.g., row mapper interfaces, private input shapes) should be declared next to the service that owns them and not exported from `server/shared/types`.
- Validate input with Zod. Complete procedure input schemas live in `server/trpc/schemas.ts`; compose them from frontend form contracts in `server/shared/schemas.ts` when an API accepts a form payload. Do not duplicate form validation rules in the tRPC layer.
- Map error messages to user-facing Chinese text where appropriate.
- **Admin delegation:** profile procedures that support acting on another user accept an `operate_for` target user id and call `resolve_operate_target(event, operate_for)` from `server/services/auth-guards.service.ts` (defaults to self; requires admin when targeting another user). Do not create parallel admin-only profile procedures unless the operation's input contract genuinely differs from the self-service operation.
- **User row queries:** build user reads on `select_profile_row_sql` and `format_profile_row()` from `server/services/profile.service.ts`. The shared SQL covers the whitelisted `users` columns plus session-derived `last_login_at` (MAX of `user_login_sessions.login_at`), `last_seen_at` (MAX of `user_login_sessions.last_seen_at`), and `is_online`. Phone is gated by `is_profile_editable` in `format_profile_row`.
- **Presence/timestamps come from `user_login_sessions`, not the `users` table:** `users` no longer has `last_login_at`, `last_online_at`, or `session_version` — never write user-activity timestamps to `users`; derive them from session rows instead.
- MySQL timezone is forced to UTC on every connection. Timestamps are stored as UTC.
- Boolean DB fields are `tinyint(1)` and must be converted with `Boolean()` before returning to the client.
- Date handling: use `dayjs` with `dayjs.extend(utc)`; store UTC, display local.
- Run tests with `pnpm test`; the policy (layout, what to assert, verifying a guard can fail) is in `.github/copilot-instructions.md` → Testing & Build. Backend behavior worth covering is the service layer: validation, the thrown `ApiError` status and Chinese message, and the side effects (rows written, objects touched, refresh published). Mock the boundary — `@server/lib/db`, `storage`, `sync`, `operation-lock` — never the service under test, and remember a transaction connection is a separate object that needs its own `execute`.
- After server-side type refactors or import changes, run `npx nuxt typecheck` to type-check the whole workspace. Type errors must be resolved before considering the task complete.
- External services (Aliyun, MQTT) are configured via `config/*.yaml`, validated in `server/shared/config.ts` (secrets are `${VAR}` interpolations from `.env`). Read `config/default.yaml`, `.env.example`, and `server/shared/config.ts` thoroughly before proposing configuration changes.
- If `.env` is not accessible, ask the user before proceeding with tasks that require secrets.
