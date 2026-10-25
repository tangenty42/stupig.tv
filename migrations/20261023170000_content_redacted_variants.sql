-- Public redaction is a version of the same attachment, never another namespace node.
ALTER TABLE content_story_attachments
  ADD COLUMN redacted_avif_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN redacted_jpeg_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN redacted_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN redacted_metadata JSON NULL,
  ADD COLUMN redacted_lqip_jpeg VARBINARY(8192) NULL;
