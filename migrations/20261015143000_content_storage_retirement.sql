-- Explicit source retirement ends the rollback window before confidentiality
-- can be tightened; retained public plaintext must not bypass application ACLs.
ALTER TABLE content_attachment_storage_migrations
  MODIFY COLUMN state ENUM('copying', 'verified', 'adopted', 'rolled_back', 'retired') NOT NULL DEFAULT 'copying';
