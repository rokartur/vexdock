-- Scheduled tasks grow the options a cron job actually needs: a note about what
-- it is for, the zone its hours are meant in, and which shell reads the
-- command. Defaults keep every existing task behaving exactly as before.
ALTER TABLE scheduled_tasks ADD COLUMN description TEXT NOT NULL DEFAULT '';
-- IANA name. Matching happens in this zone, so "0 3 * * *" is local 3am.
ALTER TABLE scheduled_tasks ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
-- 'sh' or 'bash'. sh is the only one Alpine images are guaranteed to have.
ALTER TABLE scheduled_tasks ADD COLUMN shell TEXT NOT NULL DEFAULT 'sh';
