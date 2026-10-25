---
description: "Use when changing SQL/TypeScript migrations, their frozen helpers, migration tooling or schema."
name: "Database Migrations"
applyTo: "**/*.sql,migrations/**/*.ts,scripts/migration/**/*.ts"
---

# Migration rules

- `migrations/` in filename order is the only schema source. There is no separate reference dump. SQL and TypeScript entries share one version chain.
- Add timestamped migrations after all applied/started entries. Never edit applied SQL, including whitespace/comments. Never change a started TS entry or its bundled dependency implementations. The historical baseline comment naming the deleted dump is frozen too.
- Pin SQL hashes and complete TS bundle digests in `scripts/migration/frozen.test.ts`. Test fresh replay, resumability and frozen artifacts; a fresh DB alone cannot detect historical edits.
- TS entries follow `20261024020000_migration_runs.sql` and use `define_migration` from `scripts/migration/contract.ts`. Keep imports side-effect free and plan/verify read-only. Maintenance is the default execution mode. Use `ctx.transaction` for atomic effects/checkpoints; reconcile uncertain external outcomes instead of blindly repeating writes.
- `migration_runs` is the single current ledger; completed status and `finished_at` constitute a receipt. The legacy table is adopted/verified/dropped during upgrade and must not be recreated.
- Automatic adoption of historical business DBs without receipts is limited through `20261024010000_content_preload.sql`. Later SQL and all TS scripts must execute. Explicit baseline requires a `--through` boundary within the allowed historical range. Empty databases execute the chain.
- A failed SQL step may have committed partially: inspect before using explicit retry. Do not fabricate completion, delete failed receipts, or edit checksums to hide a real source change.
- Checksum repair is permitted only after proving a line-ending-only difference against canonical bytes and recorded hashes; repair the actual ledger and normalize the working copy. For real edits, restore canonical bytes and preserve the receipt. Follow the detailed [recovery procedure](../../docs/operations/migrations.md).
- Use snake_case table names, UTC timestamps and `tinyint(1)` booleans. DB connections force UTC; convert booleans at API boundaries.
- Maintain reversibility/backup procedures where possible. Destructive operations require explicit user authorization. A code rollback alone is not a data rollback; do not promise a generic `down` that does not exist.
- Keep configuration/schema/template changes consistent when needed. Core migration tooling validates DB configuration only; scripts may load their explicitly required OSS/image subtrees, without unrelated JWT/MQTT/SMS credentials.
- Packaging, maintenance windows, baseline limits and recovery commands: [migration operations](../../docs/operations/migrations.md). Existing Content data conversion: [Content cutover](../../docs/operations/content-cutover.md).
