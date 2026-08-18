/** Presentation helpers shared by every dense table in the panel. */

export function bytes(value: number | undefined | null): string {
	if (!value || value < 0) return '0 B'
	const units = ['B', 'KB', 'MB', 'GB', 'TB']
	let size = value
	let unit = 0
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024
		unit += 1
	}
	return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`
}

export function percent(value: number | undefined | null): string {
	if (value === undefined || value === null) return '0%'
	return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`
}

/** Compact relative time: 12s, 4m, 3h, 2d. */
export function since(iso: string | number | undefined | null): string {
	if (!iso) return '-'
	const then = typeof iso === 'number' ? iso * 1000 : Date.parse(iso)
	if (Number.isNaN(then)) return '-'
	const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.floor(hours / 24)}d ago`
}

export function duration(start: string, end: string): string {
	if (!start) return '-'
	const from = Date.parse(start)
	const to = end ? Date.parse(end) : Date.now()
	if (Number.isNaN(from) || Number.isNaN(to)) return '-'
	const seconds = Math.max(0, Math.round((to - from) / 1000))
	if (seconds < 60) return `${seconds}s`
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function shortSha(sha: string | undefined): string {
	return sha ? sha.slice(0, 7) : '-'
}

export function clock(iso: string): string {
	const parsed = Date.parse(iso)
	if (Number.isNaN(parsed)) return ''
	return new Date(parsed).toLocaleTimeString([], { hour12: false })
}

/** Docker prefixes every log line with an RFC3339 timestamp when asked to. */
const LOG_TIMESTAMP = /^(?<at>\d{4}-\d{2}-\d{2}T[\d:.]+Z) ?/u
const LOG_LEVEL = /\b(?<level>EMERG|ALERT|CRIT|FATAL|PANIC|ERROR|ERR|WARNING|WARN|NOTICE|INFO|DEBUG|TRACE)\b/iu
// Built from a char code because a literal escape trips the control-character lint.
const ANSI = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*[A-Za-z]`, 'gu')

/**
 * Nginx combined access line: client, ident, user, [time], "method path proto",
 * status, bytes, then quoted referer/agent the console has no room for.
 */
const NGINX_ACCESS =
	/^(?<client>\S+) \S+ \S+ \[[^\]]+\] "(?<method>\S+) (?<path>\S+)[^"]*" (?<status>\d{3}) (?<sent>\d+|-)/u

/**
 * Recognises an nginx access line so the console can lay it out in columns.
 * Returns null for anything else, including nginx error-log lines, which read
 * fine as prose.
 */
export function parseAccessLine(text: string) {
	const groups = NGINX_ACCESS.exec(text)?.groups
	if (!groups) return null
	const { client = '', method = '', path = '', status = '', sent = '-' } = groups
	return { client, method, path, status, bytes: sent === '-' ? 0 : Number(sent) }
}

/**
 * Splits one raw log line into the parts the console renders separately: the
 * engine timestamp as local wall clock, the message with ANSI escapes removed,
 * and the severity word the message announces itself with (used for colour).
 */
export function parseLogLine(text: string) {
	const stamp = LOG_TIMESTAMP.exec(text)
	const timestamp = stamp?.groups?.at ?? null
	const body = (stamp ? text.slice(stamp[0].length) : text).replace(ANSI, '')
	return {
		time: timestamp ? clock(timestamp) || null : null,
		timestamp,
		body,
		level: LOG_LEVEL.exec(body)?.groups?.level?.toLowerCase() ?? null,
	}
}
