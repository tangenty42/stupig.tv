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
