---
description: "Use when creating or editing Vue components, composables, stores or frontend pages."
name: "Vue Frontend Conventions"
applyTo: "app/**/*.{vue,ts}"
---

# Frontend rules

## Components and presentation

- Use Vue SFCs with `<script setup lang="ts">`; block order is template, script, style. Use typed props/emits and `withDefaults` only where runtime defaults are needed.
- Use Nuxt auto-imports rather than explicit `#imports`. Custom components use the `My` prefix; icons use `<MyIcon name="lucide:..." />`.
- Use the existing shared input, dialog, confirmation, attachment-row and Markdown body components. Check their callers before creating parallel behavior.
- Forms use `@primevue/forms` with Zod resolvers. Reuse `server/shared/schemas.ts` for form schemas/defaults; full procedure input schemas remain in `server/trpc/schemas.ts`.
- For state-preserving exclusive modes, put the keyed component roots directly inside `<KeepAlive>`; plain DOM wrappers between them are not cached.
- Use Tailwind 3 and PrimeVue. Global CSS belongs in `app/assets/css/global.css` and `primevue-overrides.css`; local styles use scoped `@apply` where appropriate. Prefer PrimeVue design tokens over generated internal selectors. Use `theme('colors.primary')` and the existing palette for semantic colors.
- Keep Tailwind's global `important` disabled. The ancestor selector strategy wraps complex variants in `:is()`, which breaks Chromium 80; global `important: true` can override inline geometry. Prefer tokens, dt and PT, with local `!` utilities only for intentional conflicts. `config/ui-style.ts` still owns Nuxt's stable body ID.
- Shared PrimeVue theme customizations belong in `config/primevue-preset.ts`; use instance `dt` or `pt` for local values and internal nodes. Retire the corresponding CSS variable override when a token is migrated, after checking both color schemes. Keep component-specific lifecycle/animation fixes in their existing CSS owner.
- Production browser support is declared in package.json's production Browserslist; `config/browser-targets.ts` maps it to legacy JS and Vite CSS targets. CSS-sensitive regressions need the production browser profile described in the testing guide, since the default E2E profile omits legacy.

## APIs, ownership and injection

- Create `useApi()` synchronously in setup. Components/pages use its named domain methods, extending the matching facade and server router together. Only transport/auth infrastructure may bypass it to avoid dependency cycles.
- `useMyToast()` and `useAuth()` require Vue injection context; never create them in asynchronous fetch handlers, MQTT callbacks or BroadcastChannel listeners. Capture needed actions in setup, or use the appropriate lower-level Nuxt-context APIs in those handlers.
- The transport handles 401 logout once; `useSyncedData` suppresses duplicate 401 toasts. Do not re-toast authentication failures in callers.
- Public API types come from `@shared/types/*`. `useApi.ts` is a facade, not a separate type/schema authority.
- Pinia owns client state that needs a shared lifecycle. Server-fetched resources remain in `useSyncedData`; do not move transport listeners or SSR cookie state into stores. Draft persistence contains serializable unsaved text/state, never `File` uploads.
- `app/utils/` functions must remain pure: no composable calls or hidden configuration reads. Capture configuration in setup and pass it to utilities.
- Use `@shared/settings` for stable browser parameters and `runtimeConfig.public` only for the validated public deployment subset; see [configuration](../../docs/deployment/configuration.md).

## Synchronization and hydration

- Default to `useSyncedData` with `universal: true`. Use `universal: false` only for caller-specific behavior/side effects or an unkeyed `fetch_without_resource` query. Direct `useDataSync` listeners are for raw events that do not represent a shared fetched resource.
- Keep server invalidations as the trigger for mutations; Content uses its transactional outbox. Preserve profile/session presence polling and admin quiet-time polling because derived time-dependent values produce no mutation event. See [realtime](../../docs/modules/realtime.md).
- Server shared-proxy/listener maps are request-isolated; client maps share `useState`. An `immediate: false` proxy is trigger-only and must not supply initial rendered data. Immediate subscribers must await an existing in-flight fetch.
- Hydration-visible state must be payload-backed or fetched identically on both sides. Use `useSyncedState()` for payload-backed refs, including writable computed wrappers. Fetchers return data rather than mutate render state; callbacks/data/loading remain staged until hydration finishes. Explicit ordinary refs are not staged.
- Do not gate identity-sensitive fetches on client cookie/user refs. For incremental results use the server-issued `viewer_key` / `base_viewer_key`; HTTP identity comes from the current token cookie.
- `useDisplayTimeContext` owns serialized time and timezone. SSR uses the timezone cookie with UTC fallback; the browser timezone and shared clock start only after `app:suspense:resolve`. No module-global mutable timezone or browser timezone reads during render.
- Keep `Dayjs` objects out of Nuxt payload state. Serialize UTC strings; use existing `app/utils/time.ts` helpers with explicit display timezone. Localize both operands for calendar-unit differences.

## Verification

Follow [testing](../../docs/development/testing.md). Cover pure logic in utilities, composables, stores and renderers; verify canvas, pointer, layout and native permissions in a browser. Run typecheck after significant type/import changes. Test behavior and source invariants only where each is appropriate; do not substitute source-text checks for reachable runtime contracts.
