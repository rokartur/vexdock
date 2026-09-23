-- A git-sourced service builds either from its Dockerfile or, as a static site,
-- from its files served by nginx. An image-sourced service may pull from a
-- private registry with its own login.

ALTER TABLE services ADD COLUMN build_type TEXT NOT NULL DEFAULT 'dockerfile';
ALTER TABLE services ADD COLUMN dockerfile TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN build_target TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN registry_url TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN registry_username TEXT NOT NULL DEFAULT '';
ALTER TABLE services ADD COLUMN registry_password_enc TEXT NOT NULL DEFAULT '';
