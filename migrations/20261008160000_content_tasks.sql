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
