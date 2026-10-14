-- Attempts are retained independently; references may point to expired history.
-- No foreign key or cascading delete: deleting history must not delete a retry.
ALTER TABLE `content_task_items`
  ADD COLUMN `retry_of_item_id` bigint UNSIGNED DEFAULT NULL,
  ADD COLUMN `superseded_at` timestamp NULL DEFAULT NULL,
  ADD UNIQUE KEY `uq_content_task_items_retry_of` (`retry_of_item_id`);

-- Rollback (only after disabling retry APIs):
-- ALTER TABLE content_task_items DROP INDEX uq_content_task_items_retry_of,
--   DROP COLUMN retry_of_item_id, DROP COLUMN superseded_at;
