-- Additive, opt-in prefetch workflow. Disable the consumer before rollback;
-- retain the ledger and budgets to avoid forgetting submissions or spending twice.
CREATE TABLE IF NOT EXISTS content_preload_sites (
  destination_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  site_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  base_url VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  lease_token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until TIMESTAMP(3) NULL,
  next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS content_preload_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  destination_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_id BIGINT UNSIGNED NOT NULL,
  attachment_id BIGINT UNSIGNED NOT NULL,
  object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  phase ENUM('queued', 'submitting', 'polling', 'completed', 'skipped', 'failed') NOT NULL DEFAULT 'queued',
  task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  submissions INT UNSIGNED NOT NULL DEFAULT 0,
  requested_at TIMESTAMP(3) NULL,
  next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_preload_object (destination_id, object_key),
  KEY idx_preload_due (destination_id, phase, next_attempt_at),
  KEY idx_preload_scope (scope_id, attachment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS content_preload_budget (
  destination_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  budget_date DATE NOT NULL,
  submissions INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (destination_id, budget_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
