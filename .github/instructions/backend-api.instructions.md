---
description: "Use when creating or editing Nitro API routes, services, or server-side code in this Nuxt project."
name: "Backend API Conventions"
applyTo: "server/**/*.ts"
---

# Backend API Guidelines

- Nitro API routes return `ok(data)` or `fail(message)` from `server/types/response.ts`.
- Throw `ApiError` for failures; do not return raw errors to the client.
- Keep DB access in `server/services/`. Avoid direct DB queries in API routes.
- Server code should use the `@server` alias.
- `server/lib/` holds low-level, stateless infrastructure and external integrations (e.g., `db.ts`, `mqtt.ts`, `session.ts`, `sms.ts`, `captcha.ts`, `sync.ts`). Services orchestrate `lib`; API routes should not call `lib` directly for business operations. `lib` should not depend on `services`.
- **Type placement rules:**
  - Public API-facing payload and response types go in `server/shared/types/` and are exposed to both client and server through the `@shared/types/*` alias. Examples: `user.ts`, `session.ts`, `otp.ts`, `api.ts` (barrel re-export).
  - Server-only types (JWT payload, `AuthUser`, internal auth input types, response envelopes, sync resource identifiers) stay in `server/types/`. Examples: `auth.ts`, `response.ts`, `sync.ts`.
  - Internal service-specific types (e.g., row mapper interfaces, private input shapes) should be declared next to the service that owns them and not exported from `server/shared/types`.
- Validate input with Zod. Shared validation schemas live in `server/shared/validate.ts` and are importable via `@shared/validate`.
- Map error messages to user-facing Chinese text where appropriate.
- **Admin delegation:** admin operations on another user's own resources go through the existing self endpoints with an `operate_for` target user id (body field on PATCH/POST routes, query param on GET/DELETE), guarded by `resolve_operate_target(event, operate_for)` from `server/services/auth-guards.service.ts` (defaults to self; requires admin when targeting another user). Do NOT create dedicated admin routes under `server/api/profile/[id]/` — extend the self endpoints instead.
- **User row queries:** build user reads on `select_profile_row_sql` and `format_profile_row()` from `server/services/profile.service.ts`. The shared SQL covers the whitelisted `users` columns plus session-derived `last_login_at` (MAX of `user_login_sessions.login_at`), `last_seen_at` (MAX of `user_login_sessions.last_seen_at`), and `is_online`. Phone is gated by `is_profile_editable` in `format_profile_row`.
- **Presence/timestamps come from `user_login_sessions`, not the `users` table:** `users` no longer has `last_login_at`, `last_online_at`, or `session_version` — never write user-activity timestamps to `users`; derive them from session rows instead.
- MySQL timezone is forced to UTC on every connection. Timestamps are stored as UTC.
- Boolean DB fields are `tinyint(1)` and must be converted with `Boolean()` before returning to the client.
- Date handling: use `dayjs` with `dayjs.extend(utc)`; store UTC, display local.
- Run tests with `pnpm test`.
- After server-side type refactors or import changes, run `npx nuxt typecheck` to type-check the whole workspace. Type errors must be resolved before considering the task complete.
- External services (Aliyun, MQTT) are configured via `server/config/env.ts`. Read `.env.example` and `server/config/env.ts` thoroughly before proposing environment changes.
- If `.env` is not accessible, ask the user before proceeding with tasks that require secrets.
