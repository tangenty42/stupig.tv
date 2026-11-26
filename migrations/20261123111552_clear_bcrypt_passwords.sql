-- NULL means the account can use SMS login and set a new password afterwards.
ALTER TABLE users
  MODIFY COLUMN password_hash VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL;

-- Clear only retired bcrypt hashes. A retry leaves any newly set password intact.
UPDATE users
SET password_hash = NULL
WHERE LEFT(password_hash, 4) COLLATE utf8mb4_bin IN ('$2a$', '$2b$', '$2y$');
