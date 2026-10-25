-- Bind a sealed, reserved upload to exactly one durable image job.
-- No cascade: interrupted/cancelled work must retain its cleanup ledger.
CREATE TABLE content_upload_images (
  session_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  job_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_upload_image_job (job_id)
);
