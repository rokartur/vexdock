-- One "volume:/path" per line; the volume is named before compose prefixes it.
ALTER TABLE services ADD COLUMN mounts TEXT NOT NULL DEFAULT '';
