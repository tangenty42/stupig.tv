-- Pause belongs to a transfer item, independent of name-resolution task pauses.
ALTER TABLE `content_task_items`
  ADD COLUMN `paused_at` timestamp NULL DEFAULT NULL,
  ADD COLUMN `control_version` bigint UNSIGNED NOT NULL DEFAULT 0;

-- Rollback after disabling transfer pause/resume APIs:
-- ALTER TABLE content_task_items DROP COLUMN paused_at, DROP COLUMN control_version;
