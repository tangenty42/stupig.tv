-- A 删减版 is now the public file named without `.good` in the same folder,
-- not columns on the private row. Move each old variant into that file. A row
-- whose new name is taken keeps its old variant and is left for manual review.
INSERT INTO content_story_attachments
  (story_id, parent_id, name, name_key, file_name, is_folder, object_key, mime_type, file_size, version,
   storage_bucket, storage_provider, oss_version_id, is_private, display_key, fallback_key, image_revision,
   is_edited, image_metadata, lqip)
SELECT p.story_id, p.parent_id,
  LEFT(p.name, CHAR_LENGTH(p.name) - 5), LEFT(p.name_key, CHAR_LENGTH(p.name_key) - 5), LEFT(p.file_name, CHAR_LENGTH(p.file_name) - 5),
  0, p.redacted_display_key, 'image/webp',
  JSON_EXTRACT(p.redacted_metadata, '$.display.size'), JSON_UNQUOTE(JSON_EXTRACT(p.redacted_metadata, '$.display.etag')),
  p.storage_bucket, 'aliyun', JSON_UNQUOTE(JSON_EXTRACT(p.redacted_metadata, '$.display.version_id')), 0,
  p.redacted_display_key, p.redacted_fallback_key, 1, 1,
  JSON_OBJECT('display', JSON_EXTRACT(p.redacted_metadata, '$.display'), 'fallback', JSON_EXTRACT(p.redacted_metadata, '$.fallback'),
    'width', JSON_EXTRACT(p.redacted_metadata, '$.width'), 'height', JSON_EXTRACT(p.redacted_metadata, '$.height'),
    'original', NULL, 'source_id', NULL, 'source_revision', NULL, 'input_basis', 'display', 'redaction_source_id', NULL),
  p.redacted_lqip
FROM content_story_attachments p
WHERE p.is_folder = 0 AND p.redacted_display_key IS NOT NULL AND p.redacted_fallback_key IS NOT NULL AND p.redacted_revision > 0
  AND LOWER(RIGHT(p.name, 5)) = '.good' AND LOWER(RIGHT(LEFT(p.name, CHAR_LENGTH(p.name) - 5), 5)) <> '.good'
  AND NOT EXISTS (SELECT 1 FROM content_story_attachments t
    WHERE t.scope_id = p.scope_id AND t.parent_id <=> p.parent_id AND t.name_key = LEFT(p.name_key, CHAR_LENGTH(p.name_key) - 5));

-- The new file now owns the objects; the private row must not retire them.
UPDATE content_story_attachments p
JOIN content_story_attachments t ON t.scope_id = p.scope_id AND t.parent_id <=> p.parent_id AND t.object_key = p.redacted_display_key
SET p.redacted_display_key = NULL, p.redacted_fallback_key = NULL, p.redacted_metadata = NULL, p.redacted_lqip = NULL,
  p.redacted_revision = p.redacted_revision + 1, p.read_revision = p.read_revision + 1, p.node_revision = p.node_revision + 1
WHERE p.redacted_display_key IS NOT NULL;
