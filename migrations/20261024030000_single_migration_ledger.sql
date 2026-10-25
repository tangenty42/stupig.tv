-- Retire the legacy completion table only after all receipts are preserved.
SET @legacy_ledger_exists = (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'
);

CREATE TEMPORARY TABLE migration_ledger_guard (
  conflicts BIGINT NOT NULL CHECK (conflicts = 0)
);

SET @ledger_check = IF(@legacy_ledger_exists,
  'INSERT INTO migration_ledger_guard SELECT COUNT(*) FROM schema_migrations l JOIN migration_runs r ON r.filename = l.filename WHERE r.checksum <> l.checksum OR r.status <> ''completed''',
  'INSERT INTO migration_ledger_guard VALUES (0)'
);
PREPARE ledger_statement FROM @ledger_check;
EXECUTE ledger_statement;
DEALLOCATE PREPARE ledger_statement;

SET @ledger_copy = IF(@legacy_ledger_exists,
  'INSERT INTO migration_runs (filename, checksum, status, phase, attempts, started_at, updated_at, finished_at) SELECT l.filename, l.checksum, ''completed'', ''verify'', 0, l.applied_at, l.applied_at, l.applied_at FROM schema_migrations l LEFT JOIN migration_runs r ON r.filename = l.filename WHERE r.filename IS NULL',
  'SELECT 1'
);
PREPARE ledger_statement FROM @ledger_copy;
EXECUTE ledger_statement;
DEALLOCATE PREPARE ledger_statement;

SET @ledger_check = IF(@legacy_ledger_exists,
  'INSERT INTO migration_ledger_guard SELECT COUNT(*) FROM schema_migrations l LEFT JOIN migration_runs r ON r.filename = l.filename WHERE r.filename IS NULL OR r.checksum <> l.checksum OR r.status <> ''completed'' OR r.finished_at IS NULL',
  'INSERT INTO migration_ledger_guard VALUES (0)'
);
PREPARE ledger_statement FROM @ledger_check;
EXECUTE ledger_statement;
DEALLOCATE PREPARE ledger_statement;

DROP TABLE IF EXISTS schema_migrations;
DROP TEMPORARY TABLE migration_ledger_guard;
