import { expect, test } from 'bun:test'
import { fromDotenv, lineProblems, saveProblems, toDotenv, unsaved } from './dotenv'

// What the manager sends in place of a secret value; sending it back leaves the secret unchanged.
const MASK = '••••••••••••'

const stored = [
	{ key: 'PORT', value: '8080', is_secret: false, updated_at: '' },
	{ key: 'DB_PASSWORD', value: MASK, is_secret: true, updated_at: '' },
	{ key: 'GREETING', value: 'hello world # not a comment', is_secret: false, updated_at: '' },
]

test('a round trip keeps every value, mask included', () => {
	expect(fromDotenv(toDotenv(stored), stored)).toEqual(stored)
})

test('a backslash before an n survives a round trip', () => {
	const paths = [{ key: 'DIR', value: 'C:\\new\\\nnext', is_secret: false, updated_at: '' }]
	expect(fromDotenv(toDotenv(paths), paths)).toEqual(paths)
})

test('a value ending in a backslash does not swallow the lines after it', () => {
	const vars = [
		{ key: 'DIR', value: 'C:\\dir\\', is_secret: false, updated_at: '' },
		{ key: 'B', value: 'x y', is_secret: false, updated_at: '' },
		{ key: 'C', value: '1', is_secret: false, updated_at: '' },
	]
	expect(fromDotenv(toDotenv(vars), vars)).toEqual(vars)
	expect(unsaved(toDotenv(vars), vars)).toBe(false)
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

test('a comment, a blank line or another quote is not an unsaved change', () => {
	const text = `# database\n\n${toDotenv(stored).replace('PORT=8080', "PORT='8080'")}\n`
	expect(unsaved(text, stored)).toBe(false)
	expect(unsaved(text.replace('8080', '9090'), stored)).toBe(true)
	expect(unsaved(`${text}NEW=1`, stored)).toBe(true)
})

test('reordered lines are not an unsaved change', () => {
	expect(unsaved(toDotenv(stored).split('\n').toReversed().join('\n'), stored)).toBe(false)
})

test('a pasted multi-line quoted value is one variable', () => {
	const pem = 'KEY="-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9==\n-----END KEY-----"\nNEXT=1'
	expect(fromDotenv(pem, [])).toEqual([
		{
			key: 'KEY',
			value: '-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9==\n-----END KEY-----',
			is_secret: true,
			updated_at: '',
		},
		{ key: 'NEXT', value: '1', is_secret: true, updated_at: '' },
	])
	expect(lineProblems(pem)).toEqual([])
})

test('names what keeps the text from parsing, with its fix', () => {
	expect(lineProblems('A=1\njust words\nB="never closed\nC=2')).toEqual([
		'"just words" is not KEY=value: fix the line or delete it.',
		'B opens a quote that never closes: add the closing ".',
	])
})

test('Save refuses keys the manager rejects or would collapse', () => {
	expect(saveProblems('1A=x\nB=1\nB=2\nC=3')).toEqual([
		'"1A" is not a valid key: use letters, digits and _, and do not start with a digit.',
		'"B" appears twice: keep one.',
	])
	expect(saveProblems('A=1\nB=2')).toEqual([])
})

test('an inline comment is not part of the value, as compose reads it', () => {
	const text =
		'A="x" # note\nB=plain # note\nC=no#comment\nD=\'y\' # note\nE="-----BEGIN KEY-----\nabc\n-----END KEY-----" # pem'
	expect(fromDotenv(text, []).map(v => v.value)).toEqual([
		'x',
		'plain',
		'no#comment',
		'y',
		'-----BEGIN KEY-----\nabc\n-----END KEY-----',
	])
	expect(lineProblems(text)).toEqual([])
})
