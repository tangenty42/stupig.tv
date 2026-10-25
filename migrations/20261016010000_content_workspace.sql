-- Add the new namespace without interpreting or deleting production legacy data.
-- Offline cutover must populate parents/names before enabling the new workspace.
ALTER TABLE content_story_attachments
  DROP INDEX uq_content_story_attachments_scope_file,
  MODIFY COLUMN file_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  ADD COLUMN parent_id BIGINT UNSIGNED NULL,
  ADD COLUMN name VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN name_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD COLUMN node_revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  ADD UNIQUE KEY uq_content_node_name (scope_id, parent_id, name_key);

CREATE TABLE content_command_receipts (
  actor_id BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_id BIGINT UNSIGNED NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result JSON NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor_id, request_id),
  KEY idx_content_receipt_scope (scope_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE content_transfer_sessions
  DROP INDEX uq_transfer_reservation,
  ADD COLUMN replacement_attachment_id BIGINT UNSIGNED NULL,
  ADD COLUMN target_parent_id BIGINT UNSIGNED NULL,
  ADD COLUMN target_name_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD COLUMN source_attachment_id BIGINT UNSIGNED NULL,
  ADD COLUMN reserved_parent_id BIGINT UNSIGNED GENERATED ALWAYS AS
    (IF(status IN ('uploading', 'queued', 'running', 'verifying'), target_parent_id, NULL)) STORED,
  ADD COLUMN reserved_name_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin GENERATED ALWAYS AS
    (IF(status IN ('uploading', 'queued', 'running', 'verifying'), target_name_key, NULL)) STORED,
  ADD COLUMN reserved_source_id BIGINT UNSIGNED GENERATED ALWAYS AS
    (IF(status IN ('uploading', 'queued', 'running', 'verifying'), source_attachment_id, NULL)) STORED,
  ADD UNIQUE KEY uq_transfer_node_reservation (scope_id, reserved_parent_id, reserved_name_key),
  ADD UNIQUE KEY uq_transfer_source_reservation (reserved_source_id);

-- Durable facts for the later cleanup executor. Runtime never loses a replaced
-- or removed object's identity merely because a best-effort network call failed.
CREATE TABLE content_object_retirements (
  object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  scope_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
