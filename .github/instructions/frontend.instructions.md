---
description: "Use when creating or editing Vue SFC components, composables, or frontend pages in this Nuxt project."
name: "Vue Frontend Conventions"
applyTo: "app/**/*.{vue,ts}"
---

# Vue Frontend Guidelines

- Use Vue SFC with `<script setup lang="ts">`.
- Declare props with `withDefaults(defineProps<...>(), { ... })` and typed emits with `defineEmits<{ 'eventName': [value: Type] }>()`.
- Rely on Nuxt auto-imports; do not explicitly import from `#imports`.
- Custom components are prefixed with `My` (e.g., `MyAvatar`, `MyDialog`, `MyIcon`).
- Render icons via `<MyIcon name="lucide:..." />`.
- Use `useMyToast()` for toast notifications and `useApi()` for API calls.
- `useMyToast()` calls PrimeVue `useToast()` eagerly, so it requires a Vue inject context — only call it synchronously inside component setup (directly, or via composables like `useAuth()` that are themselves only invoked from setup). In async contexts where inject is unavailable (fetch error handlers, BroadcastChannel/poll callbacks, MQTT listeners), do not call `useMyToast()`/`useAuth()`; use lower-level Nuxt-context APIs (`useCookie`, `useRuntimeConfig`, `navigateTo`) directly instead.
- `useApi()` must be created synchronously in setup. Its internal 401 handling clears the session via the `logout()` captured at creation (guarded to run once per page load) and throws a status-carrying `ApiError`. `useSyncedData`'s default error handler suppresses toasts for 401s (checked via the exported `get_error_status`) so the logout feedback stays clean; don't re-toast 401s in callers either.
- `useApi()` is the only API caller: pages and components must never destructure or invoke the raw `request`/`request_data` helpers directly. Add named methods to the appropriate group (`auth`, `profile`, `admin`) inside `app/composables/useApi.ts` and call those instead.
- Forms use `@primevue/forms` with Zod resolvers; shared validation helpers live in `server/shared/validate.ts` and are importable via `@shared/validate`.
- Public API response/payload types are shared through `@shared/types/*`. Prefer importing from `@shared/types` (e.g., `import type { User, Profile } from '@shared/types/user'`) instead of duplicating type definitions in `app/composables/useApi.ts` or components. Use `useApi.ts` only for the request helpers, not as a home for API shapes.
- Date handling: use `dayjs` with `dayjs.extend(utc)`; store UTC, display local.
- SSR/hydration time safety: never store `Dayjs` objects in state that crosses the Nuxt payload boundary (they don't serialize); pass UTC ISO strings and call `localize_date()` at the point of use (pattern: `otp_cooldown_until` in `MyFormField.vue` → `MyOtpButton.vue`). Calendar-unit diffs (`day`, `hour`, ...) are timezone-sensitive — localize both operands with `localize_date()` before diffing.
- When fetching client-visible state with `useSyncedData`, keep `universal: true` and be aware a proxy created with `immediate: false` is trigger-only: it has no fetched value, so never rely on it to populate data. Anything rendered identically on server and client (hydration-sensitive) must come from `useState` or an awaited immediate fetch.
- Styling: Tailwind CSS 3 + PrimeVue. Use `app/assets/css/global.css` and `app/assets/css/primevue-overrides.css` for app-wide styles. Scoped component styles use `<style scoped>` with `@apply`.
- Run tests with `pnpm test`.
- After significant frontend type refactors or import changes, run `npx nuxt typecheck` to type-check the whole workspace. Type errors must be resolved before considering the task complete.
- Avoid adding new external dependencies unless there is a clear, justified need. The project already uses PrimeVue, Tailwind, and Nuxt icons.
