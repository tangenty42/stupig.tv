---
description: "Use when editing JS, TS, Vue, JSON, YAML or Markdown; defines project formatting and reuse rules."
name: "Code Style & Linting"
applyTo: "**/*.{js,mjs,ts,vue,json,jsonc,yaml,yml,md}"
---

# Code style

ESLint (`eslint.config.mjs`, Antfu flat config) is the sole formatter. Do not introduce Prettier.

## Enforced syntax

- Two spaces, single quotes, no semicolons, trailing commas.
- Space after unary operators (`! x`, `- x`, `typeof x`) and rest/spread (`... value`); no spaces inside template placeholders.
- Vue template props use kebab-case; SFC block order is template, script, style. Snake_case props/emits are intentionally allowed.
- Imports are sorted; remove unused imports/variables or prefix deliberately unused arguments with `_`.
- Omit inferable variable/function return annotations unless they define a deliberate constraint or contract.
- Server `process` / `Buffer` globals and `console` logging are allowed. Do not undo these configured exceptions.
- Markdown permits multiple H1s, though new manuals should have one clear title. Markdown rule overrides must be scoped to Markdown files.

## Reuse and configuration

- Search existing utilities, shared modules and composables before adding helpers or parallel formatting/parsing logic. Extend the owning implementation.
- Keep `app/utils/` pure: capture composable values in setup and pass them explicitly.
- Follow the [global configuration rules](../copilot-instructions.md#configuration-and-secrets): stable browser settings, server deployment configuration and secrets have separate owners. Generated settings are not hand-edited.
- Documentation must describe current behavior, link to the authoritative code/config/policy, and distinguish unimplemented work or unverified external settings. Keep normative detail in one owning document.

## Verification

- `pnpm lint` checks; `pnpm lint:fix` fixes. Hooks use lint-staged; VS Code can apply ESLint fixes on save. Use focused fixes to preserve unrelated working changes.
- Test files obey the same style. Fix lint errors without weakening assertions or exempting whole files; use a narrow, justified disable only when a rule cannot apply.
- Follow the [global testing rules](../copilot-instructions.md#testing) and [testing guide](../../docs/development/testing.md). Type/import changes require typecheck; pure documentation changes require lint and link/command/source consistency checks.
- Intentional exceptions use `eslint-disable-next-line` with a `-- reason` suffix.
