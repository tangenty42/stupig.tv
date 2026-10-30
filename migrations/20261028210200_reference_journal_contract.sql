-- Run only after the maintenance conversion has verified every retained batch.
-- Rollback requires the pre-migration backup as well as the previous application.
ALTER TABLE content_reference_journals
  DROP COLUMN changes,
  DROP INDEX idx_content_reference_journals_created;
ALTER TABLE content_stories DROP COLUMN related_story_ids;
