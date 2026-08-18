import type { EnvVar } from './api'

/**
 * The project environment as editable .env text, so a whole file can be pasted
 * in or copied out in one go.
 *
 * Secret values arrive masked. Sending the mask back means "unchanged", so a
 * round trip through this editor never overwrites a stored secret.
 */
const MASK = '••••••••••••'

/** Quoted only when the value would not survive a bare .env line. */
function quote(value: string): string {
	if (value === '') return '""'
	if (!/[\s"'#$\\]/u.test(value)) return value
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
	if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
	return value
		.slice(1, -1)
		.replaceAll('\\n', '\n')
		.replaceAll(/\\(?<escaped>["\\])/gu, '$<escaped>')
}

export function toDotenv(vars: EnvVar[]): string {
	return vars.map(v => `${v.key}=${quote(v.value)}`).join('\n')
}

/**
 * Parses the textarea back into variables. `previous` carries the secret flag
 * of keys that already exist; keys typed here are stored as secrets.
 */
export function fromDotenv(text: string, previous: EnvVar[]): EnvVar[] {
	const wasSecret = new Map(previous.map(v => [v.key, v.is_secret]))
	const vars: EnvVar[] = []
	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		if (trimmed === '' || trimmed.startsWith('#')) continue
		const separator = trimmed.indexOf('=')
		if (separator === -1) continue
		const key = trimmed.slice(0, separator).trim()
		vars.push({
			key,
			value: unquote(trimmed.slice(separator + 1).trim()),
			is_secret: wasSecret.get(key) ?? true,
			updated_at: '',
		})
	}
	return vars
}

export { MASK }
