-- Additive checkpoint ledger. Completed rows remain as non-reusable object tombstones.
-- Rollback: stop the retirement consumer before deploying the previous application;
-- retain these columns/rows so confirmed deletions and purge duties are not lost.
ALTER TABLE content_object_retirements
  ADD COLUMN phase ENUM('queued', 'deleting', 'purging', 'completed') NOT NULL DEFAULT 'queued',
  ADD COLUMN storage_bucket VARCHAR(63) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN storage_endpoint VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN esa_site_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN esa_base_url VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN purge_task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN purge_requested_at TIMESTAMP(3) NULL,
  ADD COLUMN lease_token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN lease_until TIMESTAMP(3) NULL,
  ADD COLUMN attempts INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN completed_at TIMESTAMP(3) NULL,
  ADD COLUMN updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  ADD KEY idx_retirement_due (phase, next_attempt_at, lease_until),
  ADD KEY idx_retirement_scope (scope_id, phase);
