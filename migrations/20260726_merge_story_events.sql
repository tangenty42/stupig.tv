-- Merge content_story_events into content_stories.
-- Event dates move to a JSON array column on the story row; the per-row events
-- table is dropped after backfill. Timestamps/UTC conventions unchanged.

SET time_zone = "+00:00";

-- Add the JSON column (validated as a real JSON array). Idempotent: a previous
-- partial run may have left the column behind, so only add it when missing.
SET @add_event_dates := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `content_stories` ADD COLUMN `event_dates` JSON NOT NULL AFTER `event_precision`',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'content_stories'
    AND COLUMN_NAME = 'event_dates'
);
PREPARE stmt_add_event_dates FROM @add_event_dates;
EXECUTE stmt_add_event_dates;
DEALLOCATE PREPARE stmt_add_event_dates;

-- Backfill from content_story_events. The aggregation order is not guaranteed
-- across MySQL versions, so dates are re-sorted in the app layer on read.
UPDATE `content_stories` s
LEFT JOIN (
  SELECT
    `story_id`,
    CAST(JSON_ARRAYAGG(`event_date`) AS JSON) AS dates
  FROM `content_story_events`
  GROUP BY `story_id`
) e ON e.`story_id` = s.`id`
SET s.`event_dates` = COALESCE(e.dates, JSON_ARRAY());

-- Drop the now-merged events table.
DROP TABLE IF EXISTS `content_story_events`;

-- Rollback:
-- CREATE TABLE `content_story_events` (
--   `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT,
--   `story_id` bigint UNSIGNED NOT NULL,
--   `event_date` date NOT NULL,
--   PRIMARY KEY (`id`),
--   UNIQUE KEY `uq_content_story_events_story_date` (`story_id`,`event_date`),
--   CONSTRAINT `fk_content_story_events_story` FOREIGN KEY (`story_id`) REFERENCES `content_stories` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- INSERT INTO `content_story_events` (`story_id`, `event_date`)
--   SELECT s.`id`, jt.`event_date`
--   FROM `content_stories` s
--   JOIN JSON_TABLE(s.`event_dates`, '$[*]' COLUMNS (`event_date` date PATH '$')) jt;
-- ALTER TABLE `content_stories` DROP COLUMN `event_dates`;
