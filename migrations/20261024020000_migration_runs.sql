-- Durable execution checkpoints. schema_migrations remains the completion receipt.
CREATE TABLE IF NOT EXISTS `migration_runs` (
  `filename` varchar(255) COLLATE utf8mb4_bin NOT NULL,
  `checksum` char(64) COLLATE utf8mb4_bin NOT NULL,
  `status` enum('running', 'failed', 'completed') NOT NULL,
  `phase` enum('apply', 'verify') NOT NULL DEFAULT 'apply',
  `checkpoint` json DEFAULT NULL,
  `attempts` int unsigned NOT NULL DEFAULT 1,
  `last_error_code` varchar(64) DEFAULT NULL,
  `started_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `finished_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`filename`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
