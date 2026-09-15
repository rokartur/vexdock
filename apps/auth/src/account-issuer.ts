import type { Database } from 'bun:sqlite'

/**
 * better-auth 1.7 scopes account identity by issuer, and its migration refuses to add that column to a populated
 * `account` table, so an upgraded install crash-loops on boot. The value is knowable here: this platform
 * authenticates with email and password only, so every row gets the `local:<providerId>` the library now writes.
 *
 * ponytail: the column stays nullable, since SQLite cannot add a NOT NULL
 * column without a default. better-auth logs one warning per boot about that
 * drift; enforcing it needs a table rebuild, worth doing only if a second
 * provider ever makes the column meaningful.
 */
export function backfillAccountIssuer(database: Database): void {
	const columns = database.query('PRAGMA table_info(account)').all() as { name: string }[]

	// No table yet means a fresh install: better-auth creates it with the column.
	if (columns.length === 0) return
	if (columns.some(column => column.name === 'issuer')) return

	database.exec('ALTER TABLE account ADD COLUMN "issuer" text')
	database.exec(`UPDATE account SET "issuer" = 'local:' || "providerId" WHERE "issuer" IS NULL`)
}
