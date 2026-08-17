-- A domain either gets its certificate from Let's Encrypt or the user uploads
-- one. Both end up in the same place on disk, so only the source differs.
ALTER TABLE domains ADD COLUMN certificate_source TEXT NOT NULL DEFAULT 'letsencrypt';
ALTER TABLE certificates ADD COLUMN source TEXT NOT NULL DEFAULT 'letsencrypt';
