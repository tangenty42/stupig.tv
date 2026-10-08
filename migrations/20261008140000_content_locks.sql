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
