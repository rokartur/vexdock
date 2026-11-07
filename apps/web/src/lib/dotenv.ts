import type { EnvVar } from './api'

/** Quoted only when the value would not survive a bare .env line. */
function quote(value: string): string {
	if (value === '') return '""'
	if (!/[\s"'#$\\]/u.test(value)) return value
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
	if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
	// One pass, so the `\n` left by an escaped backslash (`\\n`) is not read as a newline.
	return value
		.slice(1, -1)
		.replaceAll(/\\(?<escaped>[n"\\])/gu, (_, escaped: string) => (escaped === 'n' ? '\n' : escaped))
}

export function toDotenv(vars: EnvVar[]): string {
	return vars.map(v => `${v.key}=${quote(v.value)}`).join('\n')
}

/** Where a double-quoted value ends: the first `"` after the opening one not escaped by a backslash, or -1. */
function closingQuote(raw: string): number {
	for (let index = 1; index < raw.length; index += 1) {
		if (raw[index] === '\\') index += 1
		else if (raw[index] === '"') return index
	}
	return -1
}

/** Drops an inline `# note` the way compose reads one: after the closing quote, or after whitespace in a bare value. */
function withoutComment(raw: string): string {
	let end = -1
	if (raw.startsWith('"')) end = closingQuote(raw)
	else if (raw.startsWith("'")) end = raw.indexOf("'", 1)
	else return raw.replace(/\s+#.*$/u, '')
	const rest = raw.slice(end + 1)
	return end !== -1 && (rest === '' || /^\s+#/u.test(rest)) ? raw.slice(0, end + 1) : raw
}

type Entry = { key: string; raw: string } | { problem: string }

function entries(text: string): Entry[] {
	const found: Entry[] = []
	// A double-quoted value runs on to its closing quote, the way dotenv and compose read a pasted PEM key.
	let open: { key: string; raw: string } | null = null
	for (const line of text.split('\n')) {
		if (open) {
			open.raw += `\n${line.trimEnd()}`
			if (closingQuote(open.raw) !== -1) {
				found.push({ key: open.key, raw: withoutComment(open.raw) })
				open = null
			}
			continue
		}
		const trimmed = line.trim()
		if (trimmed === '' || trimmed.startsWith('#')) continue
		const separator = trimmed.indexOf('=')
		if (separator === -1) {
			found.push({ problem: `"${trimmed}" is not KEY=value: fix the line or delete it.` })
			continue
		}
		const key = trimmed.slice(0, separator).trim()
		const raw = trimmed.slice(separator + 1).trim()
		if (raw.startsWith('"') && closingQuote(raw) === -1) open = { key, raw }
		else found.push({ key, raw: withoutComment(raw) })
	}
	// Every line after the open quote is part of its value, so naming those lines would point at the wrong fix.
	if (open) found.push({ problem: `${open.key} opens a quote that never closes: add the closing ".` })
	return found
}

/**
 * Parses the textarea back into variables. `previous` carries the secret flag
 * of keys that already exist; keys typed here are stored as secrets.
 */
export function fromDotenv(text: string, previous: EnvVar[]): EnvVar[] {
	const wasSecret = new Map(previous.map(v => [v.key, v.is_secret]))
	const vars: EnvVar[] = []
	for (const entry of entries(text)) {
		if ('problem' in entry) continue
		vars.push({
			key: entry.key,
			value: unquote(entry.raw),
			is_secret: wasSecret.get(entry.key) ?? true,
			updated_at: '',
		})
	}
	return vars
}

/** What keeps the text from parsing whole: a line with no `=`, or a quote that never closes. Save refuses while any
 * is left instead of dropping the lines. */
export function lineProblems(text: string): string[] {
	const problems: string[] = []
	for (const entry of entries(text)) if ('problem' in entry) problems.push(entry.problem)
	return problems
}

// The manager's rule for a key (security/validate.rs ENV_KEY_PATTERN).
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Everything Save refuses, each with its fix: the line problems, then keys the manager rejects or would collapse. */
export function saveProblems(text: string): string[] {
	const problems = lineProblems(text)
	const seen = new Set<string>()
	for (const { key } of fromDotenv(text, [])) {
		if (!ENV_KEY.test(key)) {
			const name = key === '' ? 'A key is empty' : `"${key}" is not a valid key`
			problems.push(`${name}: use letters, digits and _, and do not start with a digit.`)
		}
		// The manager upserts row by row, so a repeated key would keep only its last value without a word.
		else if (seen.has(key)) problems.push(`"${key}" appears twice: keep one.`)
		seen.add(key)
	}
	return problems
}

/** Whether Save would send something other than what is stored. The API keeps keys and values, never the file, so a
 * comment, a blank line, a different quote or another line order is not a change. */
export function unsaved(text: string, stored: EnvVar[]): boolean {
	return sortedDotenv(fromDotenv(text, stored)) !== sortedDotenv(stored)
}

// The manager reads variables ORDER BY key, so line order is never stored.
function sortedDotenv(vars: EnvVar[]) {
	return toDotenv(vars.toSorted((a, b) => a.key.localeCompare(b.key)))
}
