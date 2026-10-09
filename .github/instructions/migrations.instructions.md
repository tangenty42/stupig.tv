---
description: "Use when creating or modifying SQL migrations, schema changes, or database structure in this Nuxt project."
name: "Database Migrations"
applyTo: "**/*.sql"
---

# Database Migration Guidelines

- The `migrations/` chain is the only schema source: read the files in filename order to understand the current structure (the init migration is the baseline, later ones are deltas). There is no reference dump.
- Add a new file with a clear timestamp prefix, e.g. `20261008160000_content_tasks.sql`. Never edit an applied migration — its checksum is pinned and a mismatch aborts the run. **This includes comments and whitespace**: the checksum is a sha256 of the whole file, and a comment-only edit already took production down once (2026-10-09). Add the new file's sha256 to `scripts/frozen-migrations.test.ts` in the same commit; that list is what makes an edit visible in review, since CI replays on a fresh database and therefore cannot notice.
- The baseline's comment names `stupig_tv.sql` (the historical hand-exported dump, since deleted). That reference is frozen along with the rest of the file — do not "clean it up"; the note lives here instead.
- Table names are `snake_case`.
- Boolean fields are `tinyint(1)` and must be converted with `Boolean()` before returning to the client.
- Timestamps are `TIMESTAMP` stored in UTC (`created_at`, `updated_at` with `DEFAULT CURRENT_TIMESTAMP` / `ON UPDATE CURRENT_TIMESTAMP`).
- MySQL timezone is forced to UTC on every connection (`SET time_zone = "+00:00"`).
- Always include safe rollbacks or reversibility where possible. Avoid destructive changes without explicit user approval.
- If a migration requires environment changes, update `config/*.yaml`, `.env.example`, and `server/shared/config.ts` together.
- A database that already has business tables but no `schema_migrations` records is auto-baselined on `pnpm migrate` (registered as applied, not replayed) — this keeps container startup self-healing. A genuinely empty database always executes migrations normally, so never rely on auto-baseline to skip a new migration: every migration file must be written to execute cleanly on a schema that matches all previously applied migrations.

## Recovering from `已应用的迁移文件被改动或删除了`

The runner found a recorded file whose bytes no longer match. Decide which of the two cases it is, then fix *that* one — they need opposite repairs:

1. **Line-ending artifact.** Recompute the sha256 of the file with CRLF endings and compare it against the recorded value. If they match, the record came from a Windows checkout from before `.gitattributes` (`* text=auto eol=lf`) normalized the tree: the content never changed, only its line endings did. Update that row to the canonical (LF) sha256:
   `UPDATE schema_migrations SET checksum = '<sha256 of the file as committed>' WHERE filename = '<file>';`

   Then **normalize the working copy as well** (`rm <file> && git checkout -- <file>` — a plain `git checkout --` will not rewrite a file git already considers clean, but deleting it first forces a fresh, correctly-ended materialization). Leave this step out and the next Windows-side `pnpm migrate` records the CRLF hash again. Any migration applied from Windows can be in this state, not just the baseline.
2. **A real edit.** Restore the file to its pinned bytes (`git show <commit>:migrations/<file> > <file>`) and **do not** touch the record. Updating the record instead would erase the only evidence that a database's schema may no longer match the chain that claims to describe it.

`scripts/frozen-migrations.test.ts` holds the canonical hashes, so `pnpm test` answers the question "was it edited?" without a database. It hashes the LF form of each file, because that — not a possibly stale working copy — is what a Linux deployment reads.
