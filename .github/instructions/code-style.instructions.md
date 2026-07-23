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
- No padding inside template placeholders: `` `${statement}` `` (`@stylistic/template-curly-spacing: never`).
- Method chains: short chains (≤ 3 calls) may stay inline or break freely; chains of 4+ calls **must** break one call per line (`@stylistic/newline-per-chained-call` with `ignoreChainWithDepth: 3`).
- Template props are kebab-case: `<tag prop-name />` (`vue/attribute-hyphenation: always`).
- SFC block order: `template` → `script` → `style`.
- Imports are sorted and unused imports are removed automatically (`perfectionist` + `unused-imports`).
- Unused variables/args must be removed or prefixed with `_`.

## Project conventions the linter is configured to allow (do not "fix" these)

- snake_case props and emits (`vue/prop-name-casing` and `vue/custom-event-name-casing` are off).
- Global `process` / `Buffer` in server code (`node/prefer-global/*` off).
- `console.*` in `server/**` (it is the server logger).
- Multiple H1 headings in Markdown docs (`markdown/no-multiple-h1` off). Note: markdown rule overrides must live in a `files: ['**/*.md']`-scoped block in `eslint.config.mjs`; global overrides do not apply to md files.

## Workflow

- Run `pnpm lint` to check, `pnpm lint:fix` to auto-fix.
- Pre-commit hook (simple-git-hooks + lint-staged) auto-fixes staged files; VS Code applies ESLint fixes on save.
- After style or type changes, verify with `pnpm lint`, `npx nuxt typecheck`, and `pnpm test`.
- Do not modify test files to satisfy the linter without user approval; prefer a scoped rule override with a TODO comment instead.
- For intentional rule violations, use an `eslint-disable-next-line` comment with a `-- reason` suffix.
