-- GitHub signs its deliveries with the secret its manifest generated. The other
-- three hosts did not authenticate theirs at all, so anyone who could reach the
-- panel could force a deploy. This is the token their hook URL now carries;
-- existing connections are given one on the next boot.

ALTER TABLE git_providers ADD COLUMN webhook_secret_enc TEXT NOT NULL DEFAULT '';
