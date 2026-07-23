# Project Guidelines

## Environment & Runtime

- This project runs inside a Docker container; the Copilot session is in a Dev Container, so `pnpm` commands can run directly in the shell.
- The app is usually started with `pnpm dev` (`nuxt dev --host 0.0.0.0 --port 3042`) and is normally already running in the background. It watches files, rebuilds, and provides HMR. Before launching another `pnpm dev` instance, check whether the dev server is already active (e.g., `curl -s http://localhost:3042` or check the running terminal). If it is running, do not start a second one. Avoid `nuxt build`, `nuxt prepare`, or `nuxt generate` during development unless explicitly requested.
- Package manager is **pnpm**; do not introduce `npm` or `yarn` lock files.
- Node is configured for ESM (`"type": "module"`).

## External Services

- The app talks to a MySQL server running on the same host machine in a separate Docker container. Configuration lives in `.env` / `.env.example` and `server/config/env.ts`.
- Aliyun services are used (DYPNS, SMS, CAPTCHA). Refer to `.env.example` and `server/config/env.ts` for required keys and endpoints.
- MQTT/EMQX is used for real-time synchronization. The server publishes events via `server/lib/mqtt.ts` (topics are prefixed with `MQTT_TOPIC_PREFIX`), and the browser client receives those events through `app/composables/useDataSync.ts`. Only one active tab per browser maintains a unique WebSocket connection; background tabs disconnect via `visibilitychange` to save resources. When server-side state changes (e.g., profile updates, role changes, session invalidation), emit the appropriate refresh event via `server/lib/sync.ts` using `publish_refresh({ resource: sync_resource('<type>', <id>) })` so connected clients can reload the affected data.
- The same browser uses a `BroadcastChannel` for cross-tab transport. When `useDataSync` receives an MQTT event on the active tab, it posts the event to the BroadcastChannel so other tabs (including background tabs) are notified. `BroadcastChannel` is also the dedicated channel for cross-tab login/logout broadcasts. When implementing features that mutate shared user or admin state, emit the appropriate refresh event via `server/lib/sync.ts` so both MQTT clients and same-browser tabs stay in sync.
- If `.env` is not accessible, ask the user before proceeding with any task that requires secrets.

## Database & Migrations

- `stupig_tv.sql` is the reference schema. Read it to understand the current structure; **never modify it**.
- If a task requires changing SQL structure, provide migration SQL as a separate snippet/file. Do not edit the reference schema.
- Table names are snake_case. Timestamps are `TIMESTAMP` stored in UTC. Boolean fields are `tinyint(1)` and must be converted with `Boolean()` before returning to the client.

## Workflow Standards

- Always externalize configurable settings: change `.env`, `.env.example`, and `server/config/env.ts` together. Read these files thoroughly before proposing environment changes.
- Plan first, then wait for user approval before executing **structural or environmental changes** (e.g., new dependencies, schema changes, config/env changes, major refactors). For small, safe code edits, you may proceed directly.
- Ask follow-up questions when something is unclear; the user is welcome to clarify.
- Do not make changes without approval when approval is required.
- Do not hardcode values; make items configurable.
- Ask for clarification when there is any doubt. The user may be in Autopilot mode and cannot respond mid-round. Ask questions at the end of the conversation and wait for the next prompt.
- **Never delete or recreate files during code editing**, even if Autopilot would approve. Ask the user first using the "wait for my next prompt" approach.
- Favor minimal replacement or modification over rewriting the whole file or module.
- When updating shared server-side state that needs to be reflected in the UI (e.g., profile changes, admin role changes, user bans), do not proactively fetch from the client side. Instead, emit the appropriate refresh event via `server/lib/sync.ts` and rely on the existing data sync module to reload the affected data in all connected clients/tabs. On the client, prefer `useSyncedData` for subscribing to and reloading data. In most cases, leave `universal` at its default `true` so multiple subscribers to the same resource share one proxy and one fetch. Only set `universal: false` when the `fetcher` has caller-specific side effects or different behavior across callers. Use `useDataSync` directly only in rare cases where a component needs to react to a raw sync event without fetching a shared resource.
- SSR/client sync boundary (source of a past hydration mismatch): `get_shared_proxies()` in `useSyncedData` and `get_listeners()` in `useDataSync` return a fresh Map per call on the server but a shared `useState` Map on the client, so "existing shared proxy" paths only ever run client-side. A universal proxy created with `immediate: false` is trigger-only and carries no fetched state; subscribers must not adopt an unfetched proxy's value, and `useSyncedData` itself joins in-flight shared fetches and awaits them when `immediate` is true. Values that must match between SSR render and hydration must either be `useState` (payload-serialized) or fetched identically on both sides — plain refs reset during hydration and are only refilled by awaited immediate fetches.

## Code Conventions

- Front-end: Vue SFC with `<script setup lang="ts">`. Use `withDefaults(defineProps<...>(), { ... })` and typed `defineEmits`. Rely on Nuxt auto-imports; do not explicitly import from `#imports`.
- Custom components are prefixed with `My` (e.g., `MyAvatar`, `MyDialog`, `MyIcon`).
- Icons are rendered via `<MyIcon name="lucide:..." />`.
- Use `useMyToast()` for toast notifications and `useApi()` for API calls.
- `useMyToast()` and `useAuth()` require a Vue inject context (they call PrimeVue `useToast()` eagerly) — call them synchronously in component setup only. In async paths without inject (fetch error handlers, BroadcastChannel/poll callbacks), use Nuxt-context APIs (`useCookie`, `useRuntimeConfig`, `navigateTo`) directly. `useApi()` is created in setup and captures `logout()` for its 401 handling, so it never needs inject in its async error path.
- Forms use `@primevue/forms` with Zod resolvers; shared validation helpers live in `server/shared/validate.ts`.
- Back-end: Nitro API routes return `ok(data)` or `fail(message)` from `server/types/response.ts`. Throw `ApiError` for failures. Keep DB access in `server/services/`.
- Server code should use the `@server` alias.
- `server/lib/` holds low-level, stateless infrastructure and external integrations (e.g., `db.ts`, `mqtt.ts`, `session.ts`, `sms.ts`, `captcha.ts`, `sync.ts`). API routes should not call `lib` directly for business operations; instead they call `server/services/`, which orchestrate `lib` and other services. `lib` should not depend on `services`.
- Define server-side public/API-facing types in `server/types/` (e.g., `api.ts`, `auth.ts`, `sync.ts`). Keep internal service-specific types (e.g., row mappers, input shapes) near the service that owns them.
- Validate input with Zod. Map error messages to user-facing Chinese text where appropriate.
- Date handling: use `dayjs` with `dayjs.extend(utc)`; store UTC, display local. MySQL timezone is forced to UTC on every connection.
- Styling: Tailwind CSS 3 + PrimeVue. Use `global.css` and `primevue-overrides.css` for app-wide styles. Scoped component styles use `<style scoped>` with `@apply`.

## Testing & Build

- Run tests with `pnpm test` (`vitest run`).
- Do not create or modify test files without user approval. If a change clearly benefits from tests and is straightforward to cover, mention the recommendation and ask before adding them.
- After type refactors or import changes on either the frontend or the backend, run `npx nuxt typecheck` to type-check the whole workspace. Type errors must be resolved before considering the task complete.
- Avoid adding new external dependencies unless there is a clear, justified need. The project already uses PrimeVue, Tailwind, and Nuxt icons.
