-- Business confidentiality and physical object location are independent.
ALTER TABLE content_story_attachments
  ADD COLUMN storage_bucket ENUM('public', 'private') NOT NULL DEFAULT 'public' AFTER is_private;
UPDATE content_story_attachments SET storage_bucket = 'private' WHERE is_private = 1;
ALTER TABLE content_story_attachments ALTER COLUMN storage_bucket SET DEFAULT 'private';

-- Existing upload IDs belong to the public bucket; new staging uses secret.
ALTER TABLE content_task_items
  ADD COLUMN staging_bucket ENUM('public', 'private') NOT NULL DEFAULT 'public' AFTER staging_key;
ALTER TABLE content_task_items ALTER COLUMN staging_bucket SET DEFAULT 'private';

-- Retain both sides, checkpoints and adoption receipt for resumable migration.
-- No cascade: deleting an attachment must not erase rollback protection.
CREATE TABLE content_attachment_storage_migrations (
  attachment_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  story_id BIGINT UNSIGNED NOT NULL,
  source_key VARCHAR(1024) NOT NULL,
  source_version VARCHAR(255) NOT NULL,
  source_etag VARCHAR(255) NOT NULL,
  source_size BIGINT UNSIGNED NOT NULL,
  target_key VARCHAR(1024) NOT NULL,
  target_version VARCHAR(255) NULL,
  upload_id TEXT NULL,
  part_size INT UNSIGNED NOT NULL,
  parts JSON NOT NULL,
  sha256 CHAR(64) NULL,
  state ENUM('copying', 'verified', 'adopted', 'rolled_back') NOT NULL DEFAULT 'copying',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
