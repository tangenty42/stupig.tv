-- Replace user_login_sessions.status (enum) with is_logged_out (boolean).
-- Expiry is no longer a stored state: a session is expired iff expires_at <= NOW().
-- is_logged_out only tracks explicit logout and is backfilled from the old enum.
-- All statements are idempotent so a partial run can be retried safely.

SET time_zone = "+00:00";

-- Add the boolean flag.
SET @add_is_logged_out := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `user_login_sessions` ADD COLUMN `is_logged_out` tinyint(1) NOT NULL DEFAULT 0 AFTER `identity_token`',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_login_sessions'
    AND COLUMN_NAME = 'is_logged_out'
);
PREPARE stmt_add_is_logged_out FROM @add_is_logged_out;
EXECUTE stmt_add_is_logged_out;
DEALLOCATE PREPARE stmt_add_is_logged_out;

-- Backfill from the legacy status enum (only while it still exists).
SET @backfill_is_logged_out := (
  SELECT IF(
    COUNT(*) = 1,
    'UPDATE `user_login_sessions` SET `is_logged_out` = 1 WHERE `status` = ''logged_out''',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_login_sessions'
    AND COLUMN_NAME = 'status'
);
PREPARE stmt_backfill_is_logged_out FROM @backfill_is_logged_out;
EXECUTE stmt_backfill_is_logged_out;
DEALLOCATE PREPARE stmt_backfill_is_logged_out;

-- Swap the presence index from (user_id, status, last_seen_at) to
-- (user_id, is_logged_out, last_seen_at).
SET @drop_status_index := (
  SELECT IF(
    COUNT(DISTINCT INDEX_NAME) = 1,
    'ALTER TABLE `user_login_sessions` DROP INDEX `idx_user_login_sessions_user_status_seen`',
    'SELECT 1'
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_login_sessions'
    AND INDEX_NAME = 'idx_user_login_sessions_user_status_seen'
);
PREPARE stmt_drop_status_index FROM @drop_status_index;
EXECUTE stmt_drop_status_index;
DEALLOCATE PREPARE stmt_drop_status_index;

SET @add_logout_index := (
  SELECT IF(
    COUNT(DISTINCT INDEX_NAME) = 0,
    'ALTER TABLE `user_login_sessions` ADD KEY `idx_user_login_sessions_user_logout_seen` (`user_id`,`is_logged_out`,`last_seen_at`)',
    'SELECT 1'
  )
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_login_sessions'
    AND INDEX_NAME = 'idx_user_login_sessions_user_logout_seen'
);
PREPARE stmt_add_logout_index FROM @add_logout_index;
EXECUTE stmt_add_logout_index;
DEALLOCATE PREPARE stmt_add_logout_index;

-- Drop the legacy status enum.
SET @drop_status := (
  SELECT IF(
    COUNT(*) = 1,
    'ALTER TABLE `user_login_sessions` DROP COLUMN `status`',
    'SELECT 1'
  )
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_login_sessions'
    AND COLUMN_NAME = 'status'
);
PREPARE stmt_drop_status FROM @drop_status;
EXECUTE stmt_drop_status;
DEALLOCATE PREPARE stmt_drop_status;

-- Rollback:
-- ALTER TABLE `user_login_sessions`
--   ADD COLUMN `status` enum('valid','logged_out','expired') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'valid' AFTER `identity_token`;
-- UPDATE `user_login_sessions` SET `status` = 'logged_out' WHERE `is_logged_out` = 1;
-- UPDATE `user_login_sessions` SET `status` = 'expired' WHERE `is_logged_out` = 0 AND `expires_at` <= NOW();
-- ALTER TABLE `user_login_sessions` DROP INDEX `idx_user_login_sessions_user_logout_seen`;
-- ALTER TABLE `user_login_sessions` ADD KEY `idx_user_login_sessions_user_status_seen` (`user_id`,`status`,`last_seen_at`);
-- ALTER TABLE `user_login_sessions` DROP COLUMN `is_logged_out`;
