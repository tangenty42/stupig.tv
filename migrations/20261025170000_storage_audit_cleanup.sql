-- Cleanup eligibility is tied to consecutive completed inventories and object identity.
ALTER TABLE storage_audit_targets
  ADD COLUMN previous_cycle_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL;
ALTER TABLE storage_audit_findings
  ADD COLUMN object_modified_at TIMESTAMP(3) NULL;
