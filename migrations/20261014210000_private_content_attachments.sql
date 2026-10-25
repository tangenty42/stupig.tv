-- Release A: old encrypted public rows stay readable until verified migration.
ALTER TABLE content_story_attachments
  ADD COLUMN is_private TINYINT(1) NOT NULL DEFAULT 0 AFTER encryption_key;

-- Retained rollback material; no cascading FK may erase old keys or ciphertext.
CREATE TABLE content_attachment_encryption_backup (
  attachment_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  story_id BIGINT UNSIGNED NOT NULL,
  old_object_key VARCHAR(1024) NOT NULL,
  encryption_key VARCHAR(255) NOT NULL,
  old_version VARCHAR(255) NOT NULL,
  old_file_size BIGINT UNSIGNED NOT NULL,
  plaintext_sha256 CHAR(64) NOT NULL,
  private_object_key VARCHAR(1024) NOT NULL,
  private_version VARCHAR(255) NOT NULL,
  private_file_size BIGINT UNSIGNED NOT NULL,
  migrated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rolled_back_at TIMESTAMP NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
