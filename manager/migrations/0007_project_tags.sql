-- Free-form labels for grouping projects. Stored as a comma-separated list
-- because tags are slugs, are always read with their project and are never
-- queried on their own.
ALTER TABLE projects ADD COLUMN tags TEXT NOT NULL DEFAULT '';
