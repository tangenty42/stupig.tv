-- Refresh events commit with Content mutations; delivery is at least once.
-- No FK: deleting a story must not delete its outstanding refresh events.
-- Rollback: stop the consumer and retain this table until pending events drain.
CREATE TABLE content_sync_outbox (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload JSON NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until TIMESTAMP(3) NULL,
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_content_sync_due (next_attempt_at, lease_until)
) ENGINE=InnoDB;
