-- Immutable per-part signing commitments survive browser and app restarts.
-- Keep these alongside attempts for reconciliation, including cancelled uploads.
CREATE TABLE content_upload_part_grants (
  attempt_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  part_number SMALLINT UNSIGNED NOT NULL,
  byte_length BIGINT UNSIGNED NOT NULL,
  content_md5 CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (attempt_id, part_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
