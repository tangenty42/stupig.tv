-- Monotonic privacy epoch; toggling public/private back must not revive old grants.
-- Rollback: retain the column and the fail-closed edge authorization gate;
-- do not reset revisions or restore signature-only access.
ALTER TABLE content_story_attachments
  ADD COLUMN read_revision BIGINT UNSIGNED NOT NULL DEFAULT 1;
