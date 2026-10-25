-- Offline cutover owns these immutable source snapshots and target receipts.
-- No cascading FK: a later business deletion must not erase rollback material.
CREATE TABLE content_migration_references (
  story_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  source_markdown MEDIUMTEXT NOT NULL,
  source_revision BIGINT UNSIGNED NOT NULL,
  result_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE content_migration_scopes (
  scope_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  source_snapshot JSON NOT NULL,
  source_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  destination_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  adopted_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  plan JSON NOT NULL,
  state ENUM('copying', 'adopted') NOT NULL DEFAULT 'copying',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  adopted_at TIMESTAMP NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Exact Aliyun source keys retained for rollback. Retirement must consult these pins.
CREATE TABLE content_migration_pins (
  object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  scope_id BIGINT UNSIGNED NOT NULL,
  retired_at TIMESTAMP NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE content_migration_objects (
  id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  scope_id BIGINT UNSIGNED NOT NULL,
  attachment_id BIGINT UNSIGNED NOT NULL,
  role VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_provider ENUM('legacy', 'aliyun', 'generated') NOT NULL,
  source_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_identity JSON NOT NULL,
  target_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  upload_id TEXT NULL,
  part_size INT UNSIGNED NOT NULL,
  parts JSON NOT NULL,
  expected_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  expected_size BIGINT UNSIGNED NULL,
  result JSON NULL,
  state ENUM('copying', 'verified') NOT NULL DEFAULT 'copying',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_content_migration_target(target_key),
  KEY idx_content_migration_source(source_provider, source_key),
  KEY idx_content_migration_scope(scope_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
