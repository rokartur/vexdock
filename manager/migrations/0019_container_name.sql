-- What a service's container is called on the host. Compose would otherwise
-- name it after the environment's opaque id, which reads as p_01hz...-db-1 in
-- docker ps. Existing rows stay empty and keep the names their containers
-- already have: renaming one makes compose recreate it.
ALTER TABLE services ADD COLUMN container_name TEXT NOT NULL DEFAULT '';
