---
description: "Use when creating or modifying SQL migrations, schema changes, or database structure in this Nuxt project."
name: "Database Migrations"
applyTo: "**/*.sql"
---

# Database Migration Guidelines

- Read `stupig_tv.sql` first to understand the current schema. **Never modify `stupig_tv.sql` directly**.
- Provide migration SQL as a separate snippet or file. Name migrations with a clear timestamp prefix, e.g., `timestamp_migration.sql`.
- Table names are `snake_case`.
- Boolean fields are `tinyint(1)` and must be converted with `Boolean()` before returning to the client.
- Timestamps are `TIMESTAMP` stored in UTC (`created_at`, `updated_at` with `DEFAULT CURRENT_TIMESTAMP` / `ON UPDATE CURRENT_TIMESTAMP`).
- MySQL timezone is forced to UTC on every connection (`SET time_zone = "+00:00"`).
- Always include safe rollbacks or reversibility where possible. Avoid destructive changes without explicit user approval.
- If a migration requires environment changes, update `config/*.yaml`, `.env.example`, and `server/shared/config.ts` together.
- A database that already has business tables but no `schema_migrations` records is auto-baselined on `pnpm migrate` (registered as applied, not replayed) — this keeps container startup self-healing. A genuinely empty database always executes migrations normally, so never rely on auto-baseline to skip a new migration: every migration file must be written to execute cleanly on a schema that matches all previously applied migrations.
