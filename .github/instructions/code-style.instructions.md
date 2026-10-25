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

## Comments and prose

- Explain non-obvious reasons, invariants, compatibility constraints and failure boundaries close to the code they govern. Avoid narrating obvious statements or adding boilerplate comments to every declaration.
- Update technical claims when behavior changes; do not leave obsolete contracts beside new code. Use JSDoc for useful API contracts and ordinary comments for local reasoning, without repeating inferred types.
- Preserve existing language and the author's personal expressions; follow the [author-voice rule](../copilot-instructions.md#workflow-and-runtime). Humor and debugging anecdotes are not stale documentation merely because they are informal. Add factual corrections separately when needed.
- Keep TODOs actionable: state the remaining work and relevant constraint or issue, rather than a completed-work log. Do not invent personal anecdotes or imitate the author's voice in new comments.

### Protected content markers

The [global approval rule](../copilot-instructions.md#protected-author-content) applies to these literal, case-sensitive markers:

- `THIS IS A GOOD COMMENT BEGIN` / `THIS IS A GOOD COMMENT END`: enclose the protected comment or adjacent comment blocks, using the language's native comment syntax. Runtime code outside the markers is not protected by this comment marker.
- `THIS IS A GOOD SECTION BEGIN` / `THIS IS A GOOD SECTION END`: enclose a protected document passage, including its headings and image references. Markdown uses HTML comments so the markers do not appear in rendered prose.
- `THIS IS A GOOD DOCUMENT`: place once in a comment at the beginning of a document to protect the whole file. No end marker is needed.

Keep paired markers balanced and explicit; do not infer a section's endpoint from heading depth. Associated image assets are protected too. Before editing an enclosing file, search for `THIS IS A GOOD` and check whether the change touches a protected range or asset. Do not remove protection, move content, or apply automatic fixes to a protected range without the user's specific approval. This marker convention is a preservation instruction, not a requirement to add a test or custom lint rule for each passage.

Examples:

```ts
// THIS IS A GOOD COMMENT BEGIN
// POV: the author's original comment stays here.
// THIS IS A GOOD COMMENT END
```

```md
<!-- THIS IS A GOOD SECTION BEGIN -->
## The author's original section

Original prose and images stay here.
<!-- THIS IS A GOOD SECTION END -->
```

```md
<!-- THIS IS A GOOD DOCUMENT -->
# The author's original document
```

## Verification

- `pnpm lint` checks; `pnpm lint:fix` fixes. Hooks use lint-staged; VS Code can apply ESLint fixes on save. Use focused fixes to preserve unrelated working changes.
- Test files obey the same style. Fix lint errors without weakening assertions or exempting whole files; use a narrow, justified disable only when a rule cannot apply.
- Follow the [global testing rules](../copilot-instructions.md#testing) and [testing guide](../../docs/development/testing.md). Type/import changes require typecheck; pure documentation changes require lint and link/command/source consistency checks.
- Intentional exceptions use `eslint-disable-next-line` with a `-- reason` suffix.
