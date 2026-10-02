-- A static service serves this directory of its build path; empty looks for the usual ones.

ALTER TABLE services ADD COLUMN output_dir TEXT NOT NULL DEFAULT '';
