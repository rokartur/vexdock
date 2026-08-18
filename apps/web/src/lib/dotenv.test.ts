import { expect, test } from 'bun:test'
import { fromDotenv, MASK, toDotenv } from './dotenv'

const stored = [
	{ key: 'PORT', value: '8080', is_secret: false, updated_at: '' },
	{ key: 'DB_PASSWORD', value: MASK, is_secret: true, updated_at: '' },
	{ key: 'GREETING', value: 'hello world # not a comment', is_secret: false, updated_at: '' },
]

test('a round trip keeps every value, mask included', () => {
	expect(fromDotenv(toDotenv(stored), stored)).toEqual(stored)
})

test('keeps the secret flag of known keys, guards new ones', () => {
	const parsed = fromDotenv('PORT=3000\nAPI_TOKEN=abc', stored)
	expect(parsed).toEqual([
		{ key: 'PORT', value: '3000', is_secret: false, updated_at: '' },
		{ key: 'API_TOKEN', value: 'abc', is_secret: true, updated_at: '' },
	])
})

test('accepts pasted files: comments, blanks, quotes, multi-line values', () => {
	expect(fromDotenv('# comment\n\nA="line1\\nline2"\nB=\'raw\'\nC=\n', [])).toEqual([
		{ key: 'A', value: 'line1\nline2', is_secret: true, updated_at: '' },
		{ key: 'B', value: 'raw', is_secret: true, updated_at: '' },
		{ key: 'C', value: '', is_secret: true, updated_at: '' },
	])
})
