-- Every attachment is on Aliyun OSS without per-file encryption.
-- storage_location only derived the retired legacy bucket names.
ALTER TABLE content_story_attachments
  DROP COLUMN storage_location,
  DROP COLUMN encryption_key,
  MODIFY COLUMN storage_provider ENUM('aliyun') NOT NULL DEFAULT 'aliyun';
