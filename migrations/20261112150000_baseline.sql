-- Empty-database baseline assembled from the frozen SQL and the schema changes of retired scripts.
-- The runner creates migration_runs and executes this file only during initialization.
-- Existing databases must finish the pre-baseline release before recording this version.

-- ---- 20261008000000_init_schema.sql ----

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

-- ---- 20261008140000_content_locks.sql ----
-- 附件操作锁换表：content_operation_locks（仅 scope 级）→ content_locks
-- （path 粒度；path = '' 表示整个 scope，本阶段语义与原表一致）。
-- 后续附件任务 runner（docs/content-task-refactor.md）会开始写非空 path 的行
-- （任务持有的路径锁，含续租），task_id 列即为此预留（NULL = 非任务操作）。
--
-- 锁是瞬时租约数据（TTL 秒级），不迁移旧行；切换窗口内正在进行的操作会失
-- 去对端的 409 提示，最坏情况是双方各做一次幂等的读-改-写，影响可忽略。

CREATE TABLE IF NOT EXISTS `content_locks` (
  `scope_id` bigint UNSIGNED NOT NULL,
  `path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `kind` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `task_id` bigint UNSIGNED DEFAULT NULL,
  `token` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`scope_id`, `path`),
  KEY `idx_content_locks_task` (`task_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `content_operation_locks`;

-- ---- 20261008160000_content_tasks.sql ----
-- 附件任务队列（docs/content-task-refactor.md §3）：
-- content_tasks 记录一次用户操作（一批上传、一次拖拽移动、一次多选加密……），
-- content_task_items 是任务分解后的最小执行单元（一个文件/一条移动）。
-- 路径锁落在阶段 0 已建的 content_locks（path + task_id 列）。

CREATE TABLE IF NOT EXISTS `content_tasks` (
  `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT,
  `scope_id` bigint UNSIGNED NOT NULL,
  `kind` varchar(24) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'queued',
  `payload` json NOT NULL,
  `actor_id` bigint UNSIGNED DEFAULT NULL,
  -- 发起方实例标识，仅作"本机可续传"提示，不是授权边界
  `client_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `error` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `heartbeat_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_content_tasks_scope_status` (`scope_id`,`status`),
  KEY `idx_content_tasks_status_heartbeat` (`status`,`heartbeat_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `content_task_items` (
  `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT,
  `task_id` bigint UNSIGNED NOT NULL,
  `path` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `action` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `bytes_done` bigint UNSIGNED NOT NULL DEFAULT '0',
  `bytes_total` bigint UNSIGNED NOT NULL DEFAULT '0',
  -- 上传类任务项的服务端暂存对象与 multipart 锚（断点续传依据）
  `staging_key` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `upload_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `part_size` bigint UNSIGNED DEFAULT NULL,
  `result` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_task_items_task_path` (`task_id`,`path`),
  KEY `idx_content_task_items_task` (`task_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- 20261013130000_content_task_retries.sql ----
-- Attempts are retained independently; references may point to expired history.
-- No foreign key or cascading delete: deleting history must not delete a retry.
ALTER TABLE `content_task_items`
  ADD COLUMN `retry_of_item_id` bigint UNSIGNED DEFAULT NULL,
  ADD COLUMN `superseded_at` timestamp NULL DEFAULT NULL,
  ADD UNIQUE KEY `uq_content_task_items_retry_of` (`retry_of_item_id`);

-- Rollback (only after disabling retry APIs):
-- ALTER TABLE content_task_items DROP INDEX uq_content_task_items_retry_of,
--   DROP COLUMN retry_of_item_id, DROP COLUMN superseded_at;

-- ---- 20261013131000_content_task_pause.sql ----
-- Pause belongs to a transfer item, independent of name-resolution task pauses.
ALTER TABLE `content_task_items`
  ADD COLUMN `paused_at` timestamp NULL DEFAULT NULL,
  ADD COLUMN `control_version` bigint UNSIGNED NOT NULL DEFAULT 0;

-- Rollback after disabling transfer pause/resume APIs:
-- ALTER TABLE content_task_items DROP COLUMN paused_at, DROP COLUMN control_version;

-- ---- 20261014180000_content_reference_journals.sql ----
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

-- ---- 20261014210000_private_content_attachments.sql ----
-- Release A: old encrypted public rows stay readable until verified migration.
ALTER TABLE content_story_attachments
  ADD COLUMN is_private TINYINT(1) NOT NULL DEFAULT 0 AFTER encryption_key;

-- Retained rollback material; no cascading FK may erase old keys or ciphertext.
CREATE TABLE content_attachment_encryption_backup (
  attachment_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  story_id BIGINT UNSIGNED NOT NULL,
  old_object_key VARCHAR(1024) NOT NULL,
  encryption_key VARCHAR(255) NOT NULL,
  old_version VARCHAR(255) NOT NULL,
  old_file_size BIGINT UNSIGNED NOT NULL,
  plaintext_sha256 CHAR(64) NOT NULL,
  private_object_key VARCHAR(1024) NOT NULL,
  private_version VARCHAR(255) NOT NULL,
  private_file_size BIGINT UNSIGNED NOT NULL,
  migrated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rolled_back_at TIMESTAMP NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- 20261015140000_content_secret_storage.sql ----
-- Business confidentiality and physical object location are independent.
ALTER TABLE content_story_attachments
  ADD COLUMN storage_bucket ENUM('public', 'private') NOT NULL DEFAULT 'public' AFTER is_private;
UPDATE content_story_attachments SET storage_bucket = 'private' WHERE is_private = 1;
ALTER TABLE content_story_attachments ALTER COLUMN storage_bucket SET DEFAULT 'private';

-- Existing upload IDs belong to the public bucket; new staging uses secret.
ALTER TABLE content_task_items
  ADD COLUMN staging_bucket ENUM('public', 'private') NOT NULL DEFAULT 'public' AFTER staging_key;
ALTER TABLE content_task_items ALTER COLUMN staging_bucket SET DEFAULT 'private';

-- Retain both sides, checkpoints and adoption receipt for resumable migration.
-- No cascade: deleting an attachment must not erase rollback protection.
CREATE TABLE content_attachment_storage_migrations (
  attachment_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  story_id BIGINT UNSIGNED NOT NULL,
  source_key VARCHAR(1024) NOT NULL,
  source_version VARCHAR(255) NOT NULL,
  source_etag VARCHAR(255) NOT NULL,
  source_size BIGINT UNSIGNED NOT NULL,
  target_key VARCHAR(1024) NOT NULL,
  target_version VARCHAR(255) NULL,
  upload_id TEXT NULL,
  part_size INT UNSIGNED NOT NULL,
  parts JSON NOT NULL,
  sha256 CHAR(64) NULL,
  state ENUM('copying', 'verified', 'adopted', 'rolled_back') NOT NULL DEFAULT 'copying',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- 20261015143000_content_storage_retirement.sql ----
-- Explicit source retirement ends the rollback window before confidentiality
-- can be tightened; retained public plaintext must not bypass application ACLs.
ALTER TABLE content_attachment_storage_migrations
  MODIFY COLUMN state ENUM('copying', 'verified', 'adopted', 'rolled_back', 'retired') NOT NULL DEFAULT 'copying';

-- ---- 20261015170000_content_transfer_sessions.sql ----
-- Append-only destination identity; old writers can keep changing storage_bucket.
-- The generated location follows those writes instead of becoming a stale copy.
ALTER TABLE content_story_attachments
  ADD COLUMN storage_provider ENUM('legacy', 'aliyun') NOT NULL DEFAULT 'legacy',
  ADD COLUMN storage_location VARCHAR(32) GENERATED ALWAYS AS
    (IF(storage_provider = 'aliyun', 'aliyun', CONCAT('legacy_', storage_bucket))) STORED,
  ADD COLUMN oss_version_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL;

ALTER TABLE content_task_items
  ADD COLUMN staging_provider ENUM('legacy', 'aliyun') NOT NULL DEFAULT 'legacy',
  ADD COLUMN staging_location VARCHAR(32) GENERATED ALWAYS AS
    (IF(staging_provider = 'aliyun', 'aliyun', CONCAT('legacy_', staging_bucket))) STORED;

-- Dedicated per-file transfer intents, not arbitrary executable task payloads.
-- Receipts remain after terminal states: an expired request must not start again.
CREATE TABLE content_transfer_sessions (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  actor_id BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_id BIGINT UNSIGNED NOT NULL,
  operation ENUM('upload', 'copy', 'restore') NOT NULL,
  intent JSON NOT NULL,
  target_path VARCHAR(255) NOT NULL,
  target_location ENUM('legacy_public', 'legacy_private', 'aliyun') NOT NULL,
  expected_size BIGINT UNSIGNED NOT NULL,
  status ENUM('uploading', 'queued', 'running', 'verifying', 'completed', 'cancelled', 'failed', 'expired') NOT NULL,
  reserved_path VARCHAR(255) GENERATED ALWAYS AS
    (IF(status IN ('uploading', 'queued', 'running', 'verifying'), target_path, NULL)) STORED,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  execution_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,
  executor_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until TIMESTAMP(3) NULL,
  claim_count INT UNSIGNED NOT NULL DEFAULT 0,
  active_attempt_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  next_run_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at TIMESTAMP(3) NOT NULL,
  result JSON NULL,
  error_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_transfer_request (actor_id, request_id),
  UNIQUE KEY uq_transfer_reservation (scope_id, reserved_path),
  KEY idx_transfer_ready (status, next_run_at, lease_until),
  KEY idx_transfer_scope (scope_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- No cascading deletion: cancelled/failed attempts still need durable cleanup.
CREATE TABLE content_transfer_attempts (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  session_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_epoch BIGINT UNSIGNED NOT NULL,
  target_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  upload_id TEXT NULL,
  part_size BIGINT UNSIGNED NOT NULL,
  status ENUM('created', 'uploading', 'verified', 'adopted') NOT NULL DEFAULT 'created',
  object_etag VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  oss_version_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  cleanup_required TINYINT(1) NOT NULL DEFAULT 0,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_transfer_object (target_key),
  KEY idx_transfer_attempt_session (session_id),
  KEY idx_transfer_cleanup (cleanup_required, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE content_transfer_parts (
  attempt_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  part_number SMALLINT UNSIGNED NOT NULL,
  range_start BIGINT UNSIGNED NOT NULL,
  byte_length BIGINT UNSIGNED NOT NULL,
  etag VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (attempt_id, part_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- 20261015190000_content_upload_part_grants.sql ----
-- Immutable per-part signing commitments survive browser and app restarts.
-- Keep these alongside attempts for reconciliation, including cancelled uploads.
CREATE TABLE content_upload_part_grants (
  attempt_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  part_number SMALLINT UNSIGNED NOT NULL,
  byte_length BIGINT UNSIGNED NOT NULL,
  content_md5 CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (attempt_id, part_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- 20261016010000_content_workspace.sql ----
-- Add the new namespace without interpreting or deleting production legacy data.
-- Offline cutover must populate parents/names before enabling the new workspace.
ALTER TABLE content_story_attachments
  DROP INDEX uq_content_story_attachments_scope_file,
  MODIFY COLUMN file_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  ADD COLUMN parent_id BIGINT UNSIGNED NULL,
  ADD COLUMN name VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN name_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD COLUMN node_revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  ADD UNIQUE KEY uq_content_node_name (scope_id, parent_id, name_key);

CREATE TABLE content_command_receipts (
  actor_id BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_id BIGINT UNSIGNED NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result JSON NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor_id, request_id),
  KEY idx_content_receipt_scope (scope_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE content_transfer_sessions
  DROP INDEX uq_transfer_reservation,
  ADD COLUMN replacement_attachment_id BIGINT UNSIGNED NULL,
  ADD COLUMN target_parent_id BIGINT UNSIGNED NULL,
  ADD COLUMN target_name_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD COLUMN source_attachment_id BIGINT UNSIGNED NULL,
  ADD COLUMN reserved_parent_id BIGINT UNSIGNED GENERATED ALWAYS AS
    (IF(status IN ('uploading', 'queued', 'running', 'verifying'), target_parent_id, NULL)) STORED,
  ADD COLUMN reserved_name_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin GENERATED ALWAYS AS
    (IF(status IN ('uploading', 'queued', 'running', 'verifying'), target_name_key, NULL)) STORED,
  ADD COLUMN reserved_source_id BIGINT UNSIGNED GENERATED ALWAYS AS
    (IF(status IN ('uploading', 'queued', 'running', 'verifying'), source_attachment_id, NULL)) STORED,
  ADD UNIQUE KEY uq_transfer_node_reservation (scope_id, reserved_parent_id, reserved_name_key),
  ADD UNIQUE KEY uq_transfer_source_reservation (reserved_source_id);

-- Durable facts for the later cleanup executor. Runtime never loses a replaced
-- or removed object's identity merely because a best-effort network call failed.
CREATE TABLE content_object_retirements (
  object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  scope_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---- 20261016220000_content_image_variants.sql ----
-- Additive only: existing attachments are not inferred or converted here.
ALTER TABLE content_story_attachments
  ADD COLUMN original_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN avif_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN jpeg_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN parent_avif_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN image_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN is_edited TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN image_metadata JSON NULL,
  ADD COLUMN lqip_jpeg VARBINARY(8192) NULL;

-- No cascade: abandoned output identities must survive source/row deletion.
CREATE TABLE content_image_jobs (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  scope_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  intent JSON NOT NULL,
  status ENUM('queued', 'processing', 'ready', 'completed', 'cancelled', 'failed') NOT NULL DEFAULT 'queued',
  execution_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,
  executor_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until TIMESTAMP(3) NULL,
  active_attempt_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  result JSON NULL,
  error_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  attachment_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_image_job_request (actor_id, request_id),
  KEY idx_image_jobs_pending (status, lease_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE content_image_attempts (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  job_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_epoch BIGINT UNSIGNED NOT NULL,
  avif_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  jpeg_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cleanup_required TINYINT(1) NOT NULL DEFAULT 1,
  adopted TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_image_attempt_job (job_id),
  KEY idx_image_attempt_cleanup (cleanup_required)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---- 20261016230000_content_upload_images.sql ----
-- Bind a sealed, reserved upload to exactly one durable image job.
-- No cascade: interrupted/cancelled work must retain its cleanup ledger.
CREATE TABLE content_upload_images (
  session_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  job_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_upload_image_job (job_id)
);

-- ---- 20261019210000_content_object_retirement.sql ----
-- Additive checkpoint ledger. Completed rows remain as non-reusable object tombstones.
-- Rollback: stop the retirement consumer before deploying the previous application;
-- retain these columns/rows so confirmed deletions and purge duties are not lost.
ALTER TABLE content_object_retirements
  ADD COLUMN phase ENUM('queued', 'deleting', 'purging', 'completed') NOT NULL DEFAULT 'queued',
  ADD COLUMN storage_bucket VARCHAR(63) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN storage_endpoint VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN esa_site_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN esa_base_url VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN purge_task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN purge_requested_at TIMESTAMP(3) NULL,
  ADD COLUMN lease_token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN lease_until TIMESTAMP(3) NULL,
  ADD COLUMN attempts INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN completed_at TIMESTAMP(3) NULL,
  ADD COLUMN updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  ADD KEY idx_retirement_due (phase, next_attempt_at, lease_until),
  ADD KEY idx_retirement_scope (scope_id, phase);

-- ---- 20261019223000_content_read_revision.sql ----
-- Monotonic privacy epoch; toggling public/private back must not revive old grants.
-- Rollback: retain the column and the fail-closed edge authorization gate;
-- do not reset revisions or restore signature-only access.
ALTER TABLE content_story_attachments
  ADD COLUMN read_revision BIGINT UNSIGNED NOT NULL DEFAULT 1;

-- ---- 20261021150000_content_sync_outbox.sql ----
-- Refresh events commit with Content mutations; delivery is at least once.
-- No FK: deleting a story must not delete its outstanding refresh events.
-- Rollback: stop the consumer and retain this table until pending events drain.
CREATE TABLE content_sync_outbox (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload JSON NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until TIMESTAMP(3) NULL,
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_content_sync_due (next_attempt_at, lease_until)
) ENGINE=InnoDB;

-- ---- 20261023170000_content_redacted_variants.sql ----
-- Public redaction is a version of the same attachment, never another namespace node.
ALTER TABLE content_story_attachments
  ADD COLUMN redacted_avif_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN redacted_jpeg_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN redacted_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN redacted_metadata JSON NULL,
  ADD COLUMN redacted_lqip_jpeg VARBINARY(8192) NULL;

-- ---- 20261024010000_content_preload.sql ----
-- Additive, opt-in prefetch workflow. Disable the consumer before rollback;
-- retain the ledger and budgets to avoid forgetting submissions or spending twice.
CREATE TABLE IF NOT EXISTS content_preload_sites (
  destination_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  site_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  base_url VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  lease_token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until TIMESTAMP(3) NULL,
  next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS content_preload_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  destination_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_id BIGINT UNSIGNED NOT NULL,
  attachment_id BIGINT UNSIGNED NOT NULL,
  object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  phase ENUM('queued', 'submitting', 'polling', 'completed', 'skipped', 'failed') NOT NULL DEFAULT 'queued',
  task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  submissions INT UNSIGNED NOT NULL DEFAULT 0,
  requested_at TIMESTAMP(3) NULL,
  next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_preload_object (destination_id, object_key),
  KEY idx_preload_due (destination_id, phase, next_attempt_at),
  KEY idx_preload_scope (scope_id, attachment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS content_preload_budget (
  destination_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  budget_date DATE NOT NULL,
  submissions INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (destination_id, budget_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---- 20261024210000_content_cutover_state.sql ----
-- Offline cutover owns these immutable source snapshots and target receipts.
-- No cascading FK: a later business deletion must not erase rollback material.
CREATE TABLE content_migration_references (
  story_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  source_markdown MEDIUMTEXT NOT NULL,
  source_revision BIGINT UNSIGNED NOT NULL,
  result_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE content_migration_scopes (
  scope_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  source_snapshot JSON NOT NULL,
  source_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  destination_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  adopted_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  plan JSON NOT NULL,
  state ENUM('copying', 'adopted') NOT NULL DEFAULT 'copying',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  adopted_at TIMESTAMP NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Exact Aliyun source keys retained for rollback. Retirement must consult these pins.
CREATE TABLE content_migration_pins (
  object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  scope_id BIGINT UNSIGNED NOT NULL,
  retired_at TIMESTAMP NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE content_migration_objects (
  id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  scope_id BIGINT UNSIGNED NOT NULL,
  attachment_id BIGINT UNSIGNED NOT NULL,
  role VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_provider ENUM('legacy', 'aliyun', 'generated') NOT NULL,
  source_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_identity JSON NOT NULL,
  target_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  upload_id TEXT NULL,
  part_size INT UNSIGNED NOT NULL,
  parts JSON NOT NULL,
  expected_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  expected_size BIGINT UNSIGNED NULL,
  result JSON NULL,
  state ENUM('copying', 'verified') NOT NULL DEFAULT 'copying',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_content_migration_target(target_key),
  KEY idx_content_migration_source(source_provider, source_key),
  KEY idx_content_migration_scope(scope_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---- 20261025160000_storage_audit.sql ----
-- Read-only OSS reconciliation: these ledgers never authorize object deletion.
CREATE TABLE storage_audit_targets (
  destination_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  storage_bucket VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  storage_endpoint VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cycle_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  phase ENUM('attachments', 'avatars', 'static', 'objects', 'findings', 'completed') NOT NULL DEFAULT 'completed',
  row_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  role_cursor SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  object_cursor VARBINARY(1024) NULL,
  references_checked BIGINT UNSIGNED NOT NULL DEFAULT 0,
  objects_checked BIGINT UNSIGNED NOT NULL DEFAULT 0,
  cycle_started_at TIMESTAMP(3) NULL,
  last_completed_at TIMESTAMP(3) NULL,
  next_run_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until TIMESTAMP(3) NULL,
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE storage_audit_findings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  destination_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  finding_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_key VARBINARY(2048) NOT NULL,
  kind VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expected_size BIGINT UNSIGNED NULL,
  observed_size BIGINT UNSIGNED NULL,
  observations BIGINT UNSIGNED NOT NULL DEFAULT 1,
  last_seen_cycle CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  first_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_storage_audit_finding (finding_hash),
  KEY idx_storage_audit_open (destination_id, resolved_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---- 20261025170000_storage_audit_cleanup.sql ----
-- Cleanup eligibility is tied to consecutive completed inventories and object identity.
ALTER TABLE storage_audit_targets
  ADD COLUMN previous_cycle_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL;
ALTER TABLE storage_audit_findings
  ADD COLUMN object_modified_at TIMESTAMP(3) NULL;

-- ---- 20261028210000_reference_journal_entries.sql ----
-- Expand in maintenance mode before converting the existing immutable batches.
ALTER TABLE content_reference_journals
  MODIFY COLUMN changes json NULL,
  ADD COLUMN entry_index int UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN node_id bigint UNSIGNED NULL,
  ADD COLUMN from_ref text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD COLUMN to_ref text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD COLUMN from_key text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD COLUMN to_key text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD COLUMN is_folder tinyint(1) NOT NULL DEFAULT 0,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (scope_id, revision, entry_index);

-- ---- 20261028210200_reference_journal_contract.sql ----
-- Run only after the maintenance conversion has verified every retained batch.
-- Rollback requires the pre-migration backup as well as the previous application.
ALTER TABLE content_reference_journals
  DROP COLUMN changes,
  DROP INDEX idx_content_reference_journals_created;
ALTER TABLE content_stories DROP COLUMN related_story_ids;

-- ---- 20261030120000_shared_content_drafts.sql ----
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

-- Schema effects of 20261101133000_content_webp.ts. Empty databases have no objects to convert.
ALTER TABLE content_story_attachments
  RENAME COLUMN avif_key TO display_key,
  RENAME COLUMN parent_avif_key TO source_display_key,
  RENAME COLUMN redacted_avif_key TO redacted_display_key,
  RENAME COLUMN jpeg_key TO fallback_key,
  RENAME COLUMN redacted_jpeg_key TO redacted_fallback_key,
  RENAME COLUMN lqip_jpeg TO lqip,
  RENAME COLUMN redacted_lqip_jpeg TO redacted_lqip;

ALTER TABLE content_image_attempts
  RENAME COLUMN avif_key TO display_key,
  RENAME COLUMN jpeg_key TO fallback_key;

CREATE TABLE content_webp_migration_objects (
  attachment_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  source_snapshot JSON NOT NULL,
  target_prefix VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result JSON NULL,
  adopted TINYINT(1) NOT NULL DEFAULT 0
);

-- Retire the legacy Content tables formerly removed by the deleted TS migration.
DROP TABLE IF EXISTS `content_task_items`;
DROP TABLE IF EXISTS `content_tasks`;
DROP TABLE IF EXISTS `content_locks`;
DROP TABLE IF EXISTS `content_attachment_encryption_backup`;
DROP TABLE IF EXISTS `content_attachment_storage_migrations`;
