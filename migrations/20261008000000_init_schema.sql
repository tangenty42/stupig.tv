-- ============================================================================
-- 基线迁移：stupig_tv 的初始结构
--
-- 本文件是迁移系统（scripts/migrate.ts）接管之前"手工建库"的那个结构的固化
-- 副本，把存量结构登记为第一个迁移。
--
-- 与其他迁移不同，本文件【不可重复执行】（CREATE TABLE / ADD KEY 在已有结构
-- 的库上会直接报错）。这是有意为之：
--   - 全新数据库（CI、新部署）：直接 `pnpm migrate`，本文件正常执行；
--   - 已有数据库（现网、开发库）：先跑一次 `pnpm migrate --baseline` 把本文
--     件登记为已应用（不执行 SQL），之后再正常跑后续迁移。baseline 前的潜
--     在结构漂移由人工一次性核对消化。
--   - 半途失败：DROP DATABASE 重建后重跑即可（基线只面向空库）。
--
-- 注意：
--   - schema_migrations 表由迁移执行器自建（CREATE TABLE IF NOT EXISTS），
--     不属于本基线；
--   - content_operation_locks 表会被后续迁移（附件任务队列重构）DROP；
--   - 语句顺序沿用转储：先建表，再加索引/AUTO_INCREMENT，最后加外键
--     （fk_content_stories_creator 依赖 users 表已存在）；
--   - 会话时区已由迁移执行器设置（SET time_zone = "+00:00"），无需重复；
--   - 不写 START TRANSACTION/COMMIT：MySQL DDL 隐式提交，事务包裹无意义。
-- ============================================================================

-- --------------------------------------------------------
-- 表结构
-- --------------------------------------------------------

CREATE TABLE `content_operation_locks` (
  `scope_id` bigint UNSIGNED NOT NULL,
  `kind` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `token` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `content_stories` (
  `id` bigint UNSIGNED NOT NULL,
  `title` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `label` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `description` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `cover` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `cover_label` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `cover_version` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `event_precision` enum('day','month') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `event_dates` json NOT NULL,
  `related_story_ids` json DEFAULT NULL,
  `markdown` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_by` bigint UNSIGNED DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `revision` int UNSIGNED NOT NULL DEFAULT '1'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `content_story_attachments` (
  `id` bigint UNSIGNED NOT NULL,
  `story_id` bigint UNSIGNED DEFAULT NULL,
  `scope_id` bigint UNSIGNED GENERATED ALWAYS AS (ifnull(`story_id`,0)) STORED,
  `is_folder` tinyint(1) NOT NULL DEFAULT '0',
  `file_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `object_key` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `mime_type` varchar(127) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `file_size` bigint UNSIGNED NOT NULL DEFAULT '0',
  `version` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `encryption_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `otp_send_logs` (
  `id` bigint UNSIGNED NOT NULL,
  `identity_token` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` char(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `purpose` enum('login','register','change_password','change_phone','verify_old_phone') COLLATE utf8mb4_unicode_ci NOT NULL,
  `requested_at` timestamp NOT NULL,
  `cooldown_until` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `users` (
  `id` bigint UNSIGNED NOT NULL,
  `username` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `phone` char(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `avatar_file` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `avatar_version` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `birthday` timestamp NULL DEFAULT NULL,
  `is_verified` tinyint(1) NOT NULL DEFAULT '0',
  `verified_note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_admin` tinyint(1) NOT NULL DEFAULT '0',
  `permissions` json DEFAULT NULL,
  `is_banned` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `user_login_sessions` (
  `id` bigint UNSIGNED NOT NULL,
  `user_id` bigint UNSIGNED NOT NULL,
  `identity_token` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_logged_out` tinyint(1) NOT NULL DEFAULT '0',
  `login_at` timestamp NOT NULL,
  `last_seen_at` timestamp NOT NULL,
  `logout_at` timestamp NULL DEFAULT NULL,
  `expires_at` timestamp NOT NULL,
  `login_ip` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_seen_ip` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_agent` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `user_login_session_tokens` (
  `id` bigint UNSIGNED NOT NULL,
  `session_id` bigint UNSIGNED NOT NULL,
  `token_hash` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------
-- 索引
-- --------------------------------------------------------

ALTER TABLE `content_operation_locks`
  ADD PRIMARY KEY (`scope_id`);

ALTER TABLE `content_stories`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_content_stories_title` (`title`),
  ADD KEY `idx_content_stories_updated_at` (`updated_at`),
  ADD KEY `idx_content_stories_created_by` (`created_by`);

ALTER TABLE `content_story_attachments`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_content_story_attachments_scope_file` (`scope_id`,`file_name`),
  ADD UNIQUE KEY `uq_content_story_attachments_object_key` (`object_key`),
  ADD KEY `idx_content_story_attachments_story` (`story_id`);

ALTER TABLE `otp_send_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_otp_send_logs_identity_day` (`identity_token`,`requested_at`),
  ADD KEY `idx_otp_send_logs_phone_day` (`phone`,`requested_at`),
  ADD KEY `idx_otp_send_logs_cooldown_until` (`cooldown_until`);

ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `username` (`username`),
  ADD UNIQUE KEY `phone` (`phone`),
  ADD KEY `idx_users_is_verified` (`is_verified`),
  ADD KEY `idx_users_is_admin` (`is_admin`),
  ADD KEY `idx_users_birthday` (`birthday`),
  ADD KEY `idx_users_created_at` (`created_at`),
  ADD KEY `idx_users_is_banned` (`is_banned`);

ALTER TABLE `user_login_sessions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user_login_sessions_user_login` (`user_id`,`login_at`),
  ADD KEY `idx_user_login_sessions_expires_at` (`expires_at`),
  ADD KEY `idx_user_login_sessions_user_logout_seen` (`user_id`,`is_logged_out`,`last_seen_at`);

ALTER TABLE `user_login_session_tokens`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_user_login_session_tokens_hash` (`token_hash`),
  ADD KEY `idx_user_login_session_tokens_session` (`session_id`),
  ADD KEY `idx_user_login_session_tokens_expires_at` (`expires_at`);

-- --------------------------------------------------------
-- AUTO_INCREMENT
-- --------------------------------------------------------

ALTER TABLE `content_stories`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT;

ALTER TABLE `content_story_attachments`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT;

ALTER TABLE `otp_send_logs`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT;

ALTER TABLE `users`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT;

ALTER TABLE `user_login_sessions`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT;

ALTER TABLE `user_login_session_tokens`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT;

-- --------------------------------------------------------
-- 外键
-- --------------------------------------------------------

ALTER TABLE `content_stories`
  ADD CONSTRAINT `fk_content_stories_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `user_login_sessions`
  ADD CONSTRAINT `fk_user_login_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `user_login_session_tokens`
  ADD CONSTRAINT `fk_user_login_session_tokens_session` FOREIGN KEY (`session_id`) REFERENCES `user_login_sessions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
