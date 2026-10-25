-- Append-only destination identity; old writers can keep changing storage_bucket.
-- The generated location follows those writes instead of becoming a stale copy.
ALTER TABLE content_story_attachments
  ADD COLUMN storage_provider ENUM('legacy', 'aliyun') NOT NULL DEFAULT 'legacy',
  ADD COLUMN storage_location VARCHAR(32) GENERATED ALWAYS AS
    (IF(storage_provider = 'aliyun', 'aliyun', CONCAT('legacy_', storage_bucket))) STORED,
  ADD COLUMN oss_version_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL;

ALTER TABLE content_task_items
  ADD COLUMN staging_provider ENUM('legacy', 'aliyun') NOT NULL DEFAULT 'legacy',
  ADD COLUMN staging_location VARCHAR(32) GENERATED ALWAYS AS
    (IF(staging_provider = 'aliyun', 'aliyun', CONCAT('legacy_', staging_bucket))) STORED;

-- Dedicated per-file transfer intents, not arbitrary executable task payloads.
-- Receipts remain after terminal states: an expired request must not start again.
CREATE TABLE content_transfer_sessions (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  actor_id BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_id BIGINT UNSIGNED NOT NULL,
  operation ENUM('upload', 'copy', 'restore') NOT NULL,
  intent JSON NOT NULL,
  target_path VARCHAR(255) NOT NULL,
  target_location ENUM('legacy_public', 'legacy_private', 'aliyun') NOT NULL,
  expected_size BIGINT UNSIGNED NOT NULL,
  status ENUM('uploading', 'queued', 'running', 'verifying', 'completed', 'cancelled', 'failed', 'expired') NOT NULL,
  reserved_path VARCHAR(255) GENERATED ALWAYS AS
    (IF(status IN ('uploading', 'queued', 'running', 'verifying'), target_path, NULL)) STORED,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  execution_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,
  executor_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until TIMESTAMP(3) NULL,
  claim_count INT UNSIGNED NOT NULL DEFAULT 0,
  active_attempt_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  next_run_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at TIMESTAMP(3) NOT NULL,
  result JSON NULL,
  error_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_transfer_request (actor_id, request_id),
  UNIQUE KEY uq_transfer_reservation (scope_id, reserved_path),
  KEY idx_transfer_ready (status, next_run_at, lease_until),
  KEY idx_transfer_scope (scope_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- No cascading deletion: cancelled/failed attempts still need durable cleanup.
CREATE TABLE content_transfer_attempts (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  session_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_epoch BIGINT UNSIGNED NOT NULL,
  target_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  upload_id TEXT NULL,
  part_size BIGINT UNSIGNED NOT NULL,
  status ENUM('created', 'uploading', 'verified', 'adopted') NOT NULL DEFAULT 'created',
  object_etag VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  oss_version_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  cleanup_required TINYINT(1) NOT NULL DEFAULT 0,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_transfer_object (target_key),
  KEY idx_transfer_attempt_session (session_id),
  KEY idx_transfer_cleanup (cleanup_required, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE content_transfer_parts (
  attempt_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  part_number SMALLINT UNSIGNED NOT NULL,
  range_start BIGINT UNSIGNED NOT NULL,
  byte_length BIGINT UNSIGNED NOT NULL,
  etag VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (attempt_id, part_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
