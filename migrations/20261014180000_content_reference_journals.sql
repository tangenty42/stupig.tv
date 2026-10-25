-- Additive: existing documents start at revision zero; old drafts remain unknown.
ALTER TABLE content_stories
  ADD COLUMN namespace_revision bigint UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN namespace_floor bigint UNSIGNED NOT NULL DEFAULT 0;

CREATE TABLE content_title_namespace (
  id tinyint UNSIGNED NOT NULL PRIMARY KEY,
  revision bigint UNSIGNED NOT NULL DEFAULT 0,
  revision_floor bigint UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;
INSERT INTO content_title_namespace (id) VALUES (1);

CREATE TABLE content_reference_journals (
  scope_id bigint UNSIGNED NOT NULL,
  revision bigint UNSIGNED NOT NULL,
  changes json NOT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope_id, revision),
  KEY idx_content_reference_journals_created (created_at)
) ENGINE=InnoDB;
-- scope_id = 0 is the global title namespace; story ids are strictly positive.
-- Rollback (only after reverting the application): drop these two new tables
-- and the two namespace columns. No attachment or document bytes are changed.
