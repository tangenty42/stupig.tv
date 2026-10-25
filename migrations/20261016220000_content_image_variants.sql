-- Additive only: existing attachments are not inferred or converted here.
ALTER TABLE content_story_attachments
  ADD COLUMN original_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN avif_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN jpeg_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN parent_avif_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN image_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN is_edited TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN image_metadata JSON NULL,
  ADD COLUMN lqip_jpeg VARBINARY(8192) NULL;

-- No cascade: abandoned output identities must survive source/row deletion.
CREATE TABLE content_image_jobs (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  scope_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  intent JSON NOT NULL,
  status ENUM('queued', 'processing', 'ready', 'completed', 'cancelled', 'failed') NOT NULL DEFAULT 'queued',
  execution_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,
  executor_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until TIMESTAMP(3) NULL,
  active_attempt_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  result JSON NULL,
  error_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  attachment_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_image_job_request (actor_id, request_id),
  KEY idx_image_jobs_pending (status, lease_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE content_image_attempts (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  job_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_epoch BIGINT UNSIGNED NOT NULL,
  avif_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  jpeg_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cleanup_required TINYINT(1) NOT NULL DEFAULT 1,
  adopted TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_image_attempt_job (job_id),
  KEY idx_image_attempt_cleanup (cleanup_required)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
