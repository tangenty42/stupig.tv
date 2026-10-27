# Project Guidelines

## Entry points

- Read the applicable files in [instructions/](instructions/) before editing. They define frontend, backend, code-style and migration constraints.
- [Documentation](../docs/README.md) describes the current system. Start with [architecture](../docs/architecture.md), then the relevant module. Operational procedures belong in docs, not additional instruction copies.
- Keep documentation synchronized with observable behavior. Source, validated configuration and executable policies take precedence over historical notes. Label unverified deployment assumptions explicitly.

## Workflow and runtime

- Use **pnpm** and the existing lockfile; Node runs ESM. Do not introduce npm/yarn lockfiles or unnecessary dependencies.
- Inspect the actual host/container environment and running processes. Check for an existing development server before starting another instance. `pnpm dev` owns Nuxt, the development authorization proxy and frpc; Docker dependencies stay running after Ctrl+C. See [development](../docs/development/README.md).
- Avoid `nuxt build`, `nuxt prepare` and `nuxt generate` during development unless explicitly requested. Normal installation lifecycle hooks and the documented CI build are separate workflows.
- Plan structural/environmental changes first and obtain authorization (dependencies, schema, deployment configuration, major refactors). Existing authorization in the conversation applies; do not ask again for the approved work.
- Preserve unrelated working-tree changes. Prefer focused edits. File deletion/recreation requires user authorization; a request to replace or reorganize the relevant files supplies that authorization.
- Preserve the author's voice in comments and README prose, including `POV`, jokes, anecdotes and accompanying images. A documentation rewrite, cleanup, translation or refactor is not permission to erase or normalize these passages. Check Git history when moving/replacing their surrounding content and restore accidentally removed material. Follow the protected-content markers below; if retirement makes relocation necessary, ask the user before moving the material rather than silently discarding it or restoring obsolete behavior.
- Resolve routine implementation details from the code and conversation. Ask about material ambiguity before dependent changes. In Autopilot, put required unanswered questions at the end of the reply and wait for a later prompt; do not use interactive prompts that will be skipped.
- Reuse project utilities and components before adding another implementation. Stable shared limits and deployment values belong in their owning configuration, not duplicated constants.

## Protected author content

- `THIS IS A GOOD COMMENT`, `THIS IS A GOOD SECTION` and `THIS IS A GOOD DOCUMENT` mark intentionally preserved author content. Their exact syntax and scope are defined in the [protected content marker rules](./instructions/code-style.instructions.md).
- Preserve marked text, markers and associated images/assets. Before deleting, rewriting, translating, formatting, moving or otherwise changing protected content, explain the proposed change and reason, then obtain explicit user approval for that content and action. General permission to refactor, rewrite documentation, retire a module, commit or deploy does not authorize changing protected content. Silence is not approval.
- If surrounding code or documentation becomes obsolete, propose a concrete correction or relocation and wait for approval before applying the protected portion; continue independent work where possible. Do not delete a containing file or referenced asset to bypass protection. Unmarked personal expressions still follow the author-voice rule above.

## Configuration and secrets

- Browser-safe application parameters: `config/app-settings.yaml` → `config/lib/schema.ts` → generated `server/shared/settings.generated.ts`. Consumers import `@shared/settings`; never hand-edit generated output. Run `pnpm settings:generate` after changes and `pnpm settings:check` to verify freshness.
- Deployment configuration: `config/shared.yaml` → `dev.yaml` or `prod.yaml` → optional development-only `local.yaml`. The server loads it through `@config/loader`; environment interpolation is explicit. Tracked `.env.*.layer` templates define variable names, safe defaults and placeholders; real credentials belong in local `.env.dev` / `.env.prod` or the runtime environment. See [configuration](../docs/deployment/configuration.md).
- `server/shared/` must remain browser-safe. Never import the configuration loader there at runtime, expose private configuration in Nuxt public config, or put secrets in application settings. Only the validated public subset may reach the browser.
- If necessary secrets are unavailable, ask for their local setup; do not fabricate credentials or print their values. Database-only tools must not require unrelated service secrets.

## Data integrity and synchronization

- `migrations/` in filename order is the schema source of truth. Never alter an applied SQL migration, including whitespace/comments, or a started TypeScript migration and its frozen dependency closure. Add a new version and preserve digest checks in `scripts/migration/frozen.test.ts`.
- `migration_runs` is the sole current ledger. Do not recreate `schema_migrations`, invent receipts or bypass failed migration checks. Follow [migration rules](instructions/migrations.instructions.md) and [recovery procedures](../docs/operations/migrations.md).
- Store timestamps in UTC; MySQL connections force UTC. Convert `tinyint(1)` booleans before returning API data.
- Mutations publish appropriate invalidations through the existing synchronization system. Content writes enqueue their outbox events on the business transaction connection; other domains use `server/lib/sync.ts`. Do not replace this with page-local refetches. See [realtime](../docs/modules/realtime.md).
- Background work uses the shared runner and existing domain leases/checkpoints. Preserve cooperative shutdown and receipts for in-flight external effects. See [background jobs](../docs/modules/background-jobs.md).

## Testing

- Choose verification according to the behavior and risk. Add regression coverage for defects and meaningful behavior changes; documentation, formatting and trivial plumbing do not require ceremonial tests.
- Keep unit tests beside modules as `<module>.test.ts`, mounted Vue/Nuxt tests as `<module>.nuxt.test.ts`, and browser workflows in `tests/e2e/*.spec.ts`. Shared fixtures and setup are appropriate when they remove repeated infrastructure without hiding the scenario.
- Assert observable contracts. Mock infrastructure boundaries, never the unit under test. Use the real entry point when wiring is the risk. Follow [testing](../docs/development/testing.md) for aliases, mocks and hydration constraints.
- Test observable behavior instead of source layout, private variable names or exact template strings. Replace redundant source assertions when runtime coverage exists. Preserve migration digests and other contracts whose actual subject is an artifact.
- For security, concurrency and data-loss regressions, verify that the test detects the broken behavior when practical. This is not a mandatory mutation ritual for every guard. Do not weaken a business assertion merely to get a green run.
- Run `pnpm test` for relevant behavior and `pnpm lint` for changes. After type/import refactors run `pnpm exec nuxt typecheck`; include the scripts TypeScript check when that scope changes. Resolve failures before reporting completion.

## Development test accounts

Use existing authenticated sessions or these development-only fixtures; do not create duplicates unnecessarily.

| Username | Phone | Password |
| --- | --- | --- |
| admin | 19999999999 | AaAaAaAa888 |
| user | 19000000000 | AaAaAaAa888 |

- Keep `NUXT_OTP_DEBUG=true` during development whenever possible. It skips real SMS; `false` enables the real sending path.
- Never send real SMS/OTP to these test numbers. Before any code-sending flow, verify the running server's debug mode; otherwise use password login or an existing session.

## Git and review

- Ordinary branch commit and PR titles: `type(scope): description`, one English imperative line with no trailing period. Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`. Scope is required and uses lowercase letters, digits and hyphens. Use lowercase for the description except for proper names and abbreviations that require their usual capitalization.
- An ordinary branch commit message contains only its title: no body, bullet list, rationale, test notes or trailers. Put explanations in the PR description or task report. PR titles and individual commit titles may differ. Squash merge messages follow the separate rule below.
- Branches: lowercase `type/scope/hyphenated-description`. Do not reuse merged branches or manually delete remote branches covered by automatic deletion on merge.
- After a PR is squash merged, verify the PR is merged and the corresponding local branch has no additional work. Switch to `main` when the worktree permits, update it by fast-forward, then delete that local branch; use `git branch -D` only after verifying it has no extra work, since squash merging may make `git branch -d` refuse it. Start subsequent work from updated `main`. Do not bulk-delete old branches.
- PR descriptions are English and follow [the default template](pull_request_template.md): `Background`, `Changes`, `Impact`, `Verification`, `Evidence & References`, in that order. Use concise bullets and `None` where appropriate.
- `Verification` records checks performed and their results. `Evidence & References` contains supporting material for the observed problem or proposed decision: redacted logs, screenshots, recordings, reproductions, measurements, related issues/PRs, or external references. Use `None` when no supporting material is needed. Describe documentation changes under `Changes`, not as a substitute for evidence; do not duplicate the verification checklist. Never include credentials, complete signed URLs or unnecessary personal data.
- `main` stays linear. Merge pull requests with squash only; do not create merge commits, rebase-merge, or merge locally into `main`.
- Squash merge messages use the PR title followed by ` (#<PR id>)`. For one commit, the message contains only that title. For multiple commits, add a blank line after the title, then list each merged commit title as its own `* <commit title>` bullet in GitHub's order, with exactly one blank line between bullets. Use UTF-8 without a byte order mark (BOM) or other invisible characters before the first bullet. Adjust GitHub's proposed message if its repository-configured default differs. Do not add summaries, test notes, trailers or other prose. An explicit user request for an exception in the current task takes precedence over these Git conventions.
