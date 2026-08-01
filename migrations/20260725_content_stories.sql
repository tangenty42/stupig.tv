-- 蠢猪档案 CMS: stories, event dates, attachments
-- Markdown is the single source of truth; title/rating/event columns are
-- extracted from the front matter on every save for list/calendar queries.

SET time_zone = "+00:00";

CREATE TABLE `content_stories` (
  `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT,
  `title` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `rating` tinyint UNSIGNED NOT NULL,
  `event_precision` enum('day','month') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `markdown` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_by` bigint UNSIGNED DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_content_stories_updated_at` (`updated_at`),
  KEY `idx_content_stories_created_by` (`created_by`),
  CONSTRAINT `fk_content_stories_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per event entry. Day-precision stories store the exact day;
-- month-precision stories store the first day of the month (YYYY-MM-01).
CREATE TABLE `content_story_events` (
  `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT,
  `story_id` bigint UNSIGNED NOT NULL,
  `event_date` date NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_story_events_story_date` (`story_id`,`event_date`),
  CONSTRAINT `fk_content_story_events_story` FOREIGN KEY (`story_id`) REFERENCES `content_stories` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `content_story_attachments` (
  `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT,
  `story_id` bigint UNSIGNED NOT NULL,
  `file_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `mime_type` varchar(127) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `file_size` bigint UNSIGNED NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_story_attachments_story_file` (`story_id`,`file_name`),
  CONSTRAINT `fk_content_story_attachments_story` FOREIGN KEY (`story_id`) REFERENCES `content_stories` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rollback:
-- DROP TABLE IF EXISTS `content_story_attachments`;
-- DROP TABLE IF EXISTS `content_story_events`;
-- DROP TABLE IF EXISTS `content_stories`;

-- One-time cleanup for databases that carried the abandoned draft schema
-- (empty `content_stories` with event_start/event_end + `content_attachments`):
-- ALTER TABLE `content_stories`
--   MODIFY `title` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
--   DROP COLUMN `event_start`,
--   DROP COLUMN `event_end`;
-- DROP TABLE IF EXISTS `content_attachments`;
