CREATE TABLE content_story_drafts (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  story_id BIGINT UNSIGNED NULL,
  create_request_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  markdown MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  draft_revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  namespace_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  title_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  published_main_revision INT UNSIGNED NULL,
  unpublished_changes TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,
  lease_actor_id BIGINT UNSIGNED NULL,
  lease_session_id BIGINT UNSIGNED NULL,
  lease_page_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until DATETIME(3) NULL,
  last_command_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_command_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  last_command_result JSON NULL,
  UNIQUE KEY uq_content_draft_story (story_id),
  UNIQUE KEY uq_content_draft_creation (created_by, create_request_id),
  KEY idx_content_draft_updated (updated_at, id),
  CONSTRAINT fk_content_draft_story FOREIGN KEY (story_id) REFERENCES content_stories (id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT INTO content_story_drafts
  (id, story_id, markdown, namespace_revision, title_revision, published_main_revision, unpublished_changes, created_by, updated_by, created_at, updated_at)
SELECT LOWER(REPLACE(UUID(), '-', '')), s.id, s.markdown, s.namespace_revision, t.revision, s.revision, 0,
  s.created_by, s.created_by, s.created_at, s.updated_at
FROM content_stories s CROSS JOIN content_title_namespace t WHERE t.id = 1;
