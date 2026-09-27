# Project Guidelines

## Environment & Runtime

- This project runs inside a Docker container; the Copilot session is in a Dev Container, so `pnpm` commands can run directly in the shell.
- The app is usually started with `pnpm dev` (`nuxt dev --host 0.0.0.0 --port 3042`) and is normally already running in the background. It watches files, rebuilds, and provides HMR. Before launching another `pnpm dev` instance, check whether the dev server is already active (e.g., `curl -s http://localhost:3042` or check the running terminal). If it is running, do not start a second one. Avoid `nuxt build`, `nuxt prepare`, or `nuxt generate` during development unless explicitly requested.
- Package manager is **pnpm**; do not introduce `npm` or `yarn` lock files.
- Node is configured for ESM (`"type": "module"`).

## External Services

- The app talks to a MySQL server running on the same host machine in a separate Docker container. Configuration lives in `.env` / `.env.example` and `server/shared/env.ts`.
- Aliyun services are used (DYPNS, SMS, CAPTCHA). Refer to `.env.example` and `server/shared/env.ts` for required keys and endpoints.
- MQTT/EMQX is used for real-time synchronization. The server publishes events via `server/lib/mqtt.ts` (topics are prefixed with `MQTT_TOPIC_PREFIX`), and the browser client receives those events through `app/composables/useDataSync.ts`. Only one active tab per browser maintains a unique WebSocket connection; background tabs disconnect via `visibilitychange` to save resources. When server-side state changes (e.g., profile updates, role changes, session invalidation), emit the appropriate refresh event via `server/lib/sync.ts` using `publish_refresh({ resource: sync_resource('<type>', <id>) })` so connected clients can reload the affected data.
- The same browser uses a `BroadcastChannel` for cross-tab transport. When `useDataSync` receives an MQTT event on the active tab, it posts the event to the BroadcastChannel so other tabs (including background tabs) are notified. `BroadcastChannel` is also the dedicated channel for cross-tab login/logout broadcasts. When implementing features that mutate shared user or admin state, emit the appropriate refresh event via `server/lib/sync.ts` so both MQTT clients and same-browser tabs stay in sync.
- If `.env` is not accessible, ask the user before proceeding with any task that requires secrets.

## Database & Migrations

- `stupig_tv.sql` is the reference schema. Read it to understand the current structure; **never modify it**.
- If a task requires changing SQL structure, provide migration SQL as a separate snippet/file. Do not edit the reference schema.
- Table names are snake_case. Timestamps are `TIMESTAMP` stored in UTC. Boolean fields are `tinyint(1)` and must be converted with `Boolean()` before returning to the client.

## Workflow Standards

- Always externalize configurable settings: change `.env`, `.env.example`, and `server/shared/env.ts` together. Read these files thoroughly before proposing environment changes.
- Plan first, then wait for user approval before executing **structural or environmental changes** (e.g., new dependencies, schema changes, config/env changes, major refactors). For small, safe code edits, you may proceed directly.
- Ask follow-up questions when something is unclear; the user is welcome to clarify.
- Do not make changes without approval when approval is required.
- Do not hardcode values; make items configurable.
- Ask for clarification when there is any doubt. The user may be in Autopilot mode and cannot respond mid-round. Ask questions at the end of the conversation and wait for the next prompt. **In Autopilot mode, never use interactive question prompts/tools — they get auto-skipped and the questions are lost. Put open questions as plain text at the end of the reply, then end the turn without implementing the parts in doubt.**
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
- Forms use `@primevue/forms` with Zod resolvers. Frontend form schemas and defaults live in `server/shared/schemas.ts`; full procedure input schemas live in `server/trpc/schemas.ts` and reuse those form contracts where applicable.
- Back-end: expose application operations through domain routers in `server/trpc/`; the Nitro catch-all route only adapts HTTP to `app_router`. Procedures validate with Zod, delegate business operations to `server/services/`, and return their data directly. Throw `ApiError` for expected failures; the tRPC middleware maps it to the matching transport status.
- Server code should use the `@server` alias.
- `server/lib/` holds low-level, stateless infrastructure and external integrations (e.g., `db.ts`, `mqtt.ts`, `session.ts`, `sms.ts`, `captcha.ts`, `sync.ts`). tRPC procedures should not call `lib` directly for business operations; instead they call `server/services/`, which orchestrate `lib` and other services. `lib` should not depend on `services`.
- Define server-side public/API-facing types in `server/types/` (e.g., `api.ts`, `auth.ts`, `sync.ts`). Keep internal service-specific types (e.g., row mappers, input shapes) near the service that owns them.
- Validate input with Zod. Map error messages to user-facing Chinese text where appropriate.
- Date handling: use `dayjs` with `dayjs.extend(utc)`; store UTC, display local. MySQL timezone is forced to UTC on every connection.
- Styling: Tailwind CSS 3 + PrimeVue. Use `global.css` and `primevue-overrides.css` for app-wide styles. Scoped component styles use `<style scoped>` with `@apply`. To restyle a PrimeVue component's internals, prefer its design tokens (`--p-*`) over overriding generated class names; app-wide tokens go in `primevue-overrides.css`. For our own palette use Tailwind `theme('colors.primary')`, `theme('colors.primary-emphasis')` (hover), `theme('colors.primary-contrast')`, `theme('colors.primary-500')`, etc.

## Testing & Build

- Run tests with `pnpm test` (`vitest run`). There is no watch task; run the command and read the output.

**Tests are part of the change, not a follow-up.** Add them for new behavior, update them when a change makes their expectations outdated, and fix the cause of a failure rather than the assertion. If a change genuinely needs no test, say why in the reply rather than staying silent about it.

- Layout: a test lives beside the module it covers, named `<module>.test.ts` (e.g. `app/utils/content/redact.ts` → `app/utils/content/redact.test.ts`). There is no separate test directory, no shared test utilities module, and no `setupFiles`; add one only when several suites genuinely share the helper.
- Environment: Node, no DOM — there is no jsdom/happy-dom. `import.meta.client` is forced `true` and `import.meta.server` `false` by `vitest.config.ts`; the `~`, `@server` and `@shared` aliases resolve. Anything needing a real browser (canvas, layout, pointer events) is out of scope for tests.
- Assert the contract, not the implementation: the observable behavior, the returned shape, the thrown status and message, the side effect. Prefer the smallest unit that expresses the rule, but go through a real entry point when the risk being guarded is the wiring (that a guard is actually called, that a caller passes the right argument).
- Mocking: declare mocks with `vi.hoisted` and register them with `vi.mock`, then `await import()` the module under test — `vi.mock` is hoisted above imports, so a plain top-level mock would be initialized too late. Mock at the boundary (db, storage, sync, locks, clock), never the module under test. The mock's shape has to match what the code actually calls (`db.execute`, not `db.query`; a transaction connection needs its own `execute`).
- **A new guard must be able to fail.** Before trusting one, temporarily break the fix it guards and confirm the test goes red, then restore. A guard that cannot fail when the behavior breaks is worse than no guard: it advertises protection that is not there. The same applies to a guard whose fixture never reaches the branch it claims to cover.
- Never weaken a test to make it pass: no hollowed-out assertions, no `.skip`, no widening an expectation to whatever the code happens to do. If an expectation turns out to be wrong, first decide which one is right — the code or the test — and fix that one.
- A test may read project source files when the invariant is about the source itself (for example "every icon this renderer can emit is registered in the bundling list"). Say why in a comment, assert a real minimum, and prefer a runtime check when one can reach the same coverage.
- Lint applies to tests like any other code: run `pnpm lint`, and fix a test's lint error as code rather than exempting the file.

- After type refactors or import changes on either the frontend or the backend, run `npx nuxt typecheck` to type-check the whole workspace. Type errors must be resolved before considering the task complete.
- Avoid adding new external dependencies unless there is a clear, justified need. The project already uses PrimeVue, Tailwind, and Nuxt icons.
