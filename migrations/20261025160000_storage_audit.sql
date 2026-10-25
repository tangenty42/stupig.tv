-- Read-only OSS reconciliation: these ledgers never authorize object deletion.
CREATE TABLE storage_audit_targets (
  destination_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  storage_bucket VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  storage_endpoint VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cycle_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  phase ENUM('attachments', 'avatars', 'static', 'objects', 'findings', 'completed') NOT NULL DEFAULT 'completed',
  row_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  role_cursor SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  object_cursor VARBINARY(1024) NULL,
  references_checked BIGINT UNSIGNED NOT NULL DEFAULT 0,
  objects_checked BIGINT UNSIGNED NOT NULL DEFAULT 0,
  cycle_started_at TIMESTAMP(3) NULL,
  last_completed_at TIMESTAMP(3) NULL,
  next_run_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until TIMESTAMP(3) NULL,
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE storage_audit_findings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  destination_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  finding_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_key VARBINARY(2048) NOT NULL,
  kind VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expected_size BIGINT UNSIGNED NULL,
  observed_size BIGINT UNSIGNED NULL,
  observations BIGINT UNSIGNED NOT NULL DEFAULT 1,
  last_seen_cycle CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  first_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_storage_audit_finding (finding_hash),
  KEY idx_storage_audit_open (destination_id, resolved_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
