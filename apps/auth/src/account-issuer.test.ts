import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { backfillAccountIssuer } from './account-issuer'

/** The account table as better-auth 1.6 left it, with one credential account. */
function legacyDatabase(): Database {
	const database = new Database(':memory:')
	database.exec(
		'CREATE TABLE account ("id" text primary key, "accountId" text not null, "providerId" text not null, "userId" text not null)',
	)
	database.exec(`INSERT INTO account VALUES ('a1', 'u1', 'credential', 'u1')`)
	return database
}

test('gives rows written before 1.7 the issuer better-auth now requires', () => {
	const database = legacyDatabase()

	backfillAccountIssuer(database)

	expect(database.query('SELECT "issuer" FROM account').all()).toEqual([{ issuer: 'local:credential' }])
})

test('leaves an already migrated table alone', () => {
	const database = legacyDatabase()
	backfillAccountIssuer(database)
	database.exec(`UPDATE account SET "issuer" = 'local:oauth:github'`)

	backfillAccountIssuer(database)

	expect(database.query('SELECT "issuer" FROM account').all()).toEqual([{ issuer: 'local:oauth:github' }])
})

test('leaves a fresh install to better-auth', () => {
	expect(() => backfillAccountIssuer(new Database(':memory:'))).not.toThrow()
})
