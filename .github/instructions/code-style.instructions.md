---
description: "Use when writing, editing, or formatting any JS/TS/Vue/JSON/YAML/Markdown file in this project. Covers the enforced code style, ESLint setup, and formatting workflow."
name: "Code Style & Linting"
applyTo: "**/*.{js,mjs,ts,vue,json,jsonc,yaml,yml,md}"
---

# Code Style & Linting Guidelines

ESLint is the sole formatter for this project — **no Prettier**. Config lives in `eslint.config.mjs` (`@antfu/eslint-config` flat config, ESLint 10).

## Enforced style

- 2-space indent (never tabs), single quotes, no semicolons, trailing commas — all auto-fixed.
- Space after **all** unary operators: `! x`, `- x`, `typeof x`, `void x` (`@stylistic/space-unary-ops`).
- Space after rest and spread operators: `... statement` (`@stylistic/rest-spread-spacing: always`).
- No padding inside template placeholders: `` `${statement}` `` (`@stylistic/template-curly-spacing: never`).
- Template props are kebab-case: `<tag prop-name />` (`vue/attribute-hyphenation: always`).
- SFC block order: `template` → `script` → `style`.
- Imports are sorted and unused imports are removed automatically (`perfectionist` + `unused-imports`).
- Unused variables/args must be removed or prefixed with `_`.
- Omit function return type annotations when TypeScript can infer the intended type. Specify one only when it defines a deliberate contract or inference cannot express the required type.
- Omit variable type annotations when the initializer already infers the intended type. Specify one only when it constrains, widens, or otherwise changes the inferred type.
- Define stable browser-shared identifiers, limits, intervals, schema versions and storage keys in `config/app-settings.yaml`, with Zod schemas in `config/lib/schema.ts`. Run `pnpm settings:generate` and commit the generated module; consumers import `@shared/settings`. Server configuration belongs in layered YAML (`config/default.yaml`, environment override, optional development-only local override); secrets and explicitly referenced deployment variables belong in the `.env.*.layer` templates. Load and validate through `@config/lib/loader`; inject only its public subset through Nuxt runtime config. Keep `server/shared/` browser-safe and never hand-edit generated settings.
- Never call composables (`useXxx()`) inside `app/utils/` functions and never hardcode what a composable provides — utils must be pure. Capture `const xxx = useXxx()` at the top of the caller's setup block and pass it into the util as a config-like argument.
- Before adding a local helper or calling a platform formatting/parsing API directly, search `app/utils/`, shared modules, and existing composables for the project-owned equivalent. Reuse and extend the owning utility instead of duplicating behavior in a page, component, store, service, or router.

## Project conventions the linter is configured to allow (do not "fix" these)

- snake_case props and emits (`vue/prop-name-casing` and `vue/custom-event-name-casing` are off).
- Global `process` / `Buffer` in server code (`node/prefer-global/*` off).
- `console.*` in `server/**` (it is the server logger).
- Multiple H1 headings in Markdown docs (`markdown/no-multiple-h1` off). Note: markdown rule overrides must live in a `files: ['**/*.md']`-scoped block in `eslint.config.mjs`; global overrides do not apply to md files.

## Workflow

- Run `pnpm lint` to check, `pnpm lint:fix` to auto-fix.
- Pre-commit hook (simple-git-hooks + lint-staged) auto-fixes staged files; VS Code applies ESLint fixes on save.
- After style or type changes, verify with `pnpm lint`, `npx nuxt typecheck`, and `pnpm test`.
- Test files follow the same style as any other code (see `.github/copilot-instructions.md` → Testing & Build for the testing policy). A lint error in a test is fixed by correcting the code, not by hollowing out an assertion; only when a rule genuinely cannot apply, exempt that file with a scoped override plus a TODO comment.
- For intentional rule violations, use an `eslint-disable-next-line` comment with a `-- reason` suffix.
