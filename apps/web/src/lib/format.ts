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

/** The mirror of `since`, for a time that has not arrived yet: in 12m, in 6h. */
export function until(iso: string | number | undefined | null): string {
	if (!iso) return '-'
	const then = typeof iso === 'number' ? iso * 1000 : Date.parse(iso)
	if (Number.isNaN(then)) return '-'
	const seconds = Math.max(0, Math.floor((then - Date.now()) / 1000))
	if (seconds < 60) return `in ${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `in ${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `in ${hours}h`
	return `in ${Math.floor(hours / 24)}d`
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

/** Null for anything that is not an access line, including nginx's error log, which reads fine as prose. */
export function parseAccessLine(text: string) {
	const groups = NGINX_ACCESS.exec(text)?.groups
	if (!groups) return null
	const { client = '', method = '', path = '', status = '', sent = '-' } = groups
	return { client, method, path, status, bytes: sent === '-' ? 0 : Number(sent) }
}

/** Splits a raw line into the engine timestamp as wall clock, the body with and without ANSI, and its severity word. */
export function parseLogLine(text: string) {
	const stamp = LOG_TIMESTAMP.exec(text)
	const timestamp = stamp?.groups?.at ?? null
	const coloredBody = stamp ? text.slice(stamp[0].length) : text
	const body = coloredBody.replace(ANSI, '')
	return {
		time: timestamp ? clock(timestamp) || null : null,
		timestamp,
		body,
		coloredBody,
		level: LOG_LEVEL.exec(body)?.groups?.level?.toLowerCase() ?? null,
	}
}

export type AnsiSegment = { text: string; color?: string; bold: boolean }

// The 16 terminal colors, tuned to read on the console's black background.
const ANSI_COLORS = [
	'#737373',
	'#f87171',
	'#4ade80',
	'#fbbf24',
	'#60a5fa',
	'#e879f9',
	'#22d3ee',
	'#d4d4d4',
	'#8a8a8a',
	'#fca5a5',
	'#86efac',
	'#fde68a',
	'#93c5fd',
	'#f0abfc',
	'#67e8f9',
	'#ffffff',
]

/** Cuts a line at its ANSI escapes into runs of text with the color and weight the SGR codes left in effect. */
export function ansiSegments(text: string) {
	const segments: AnsiSegment[] = []
	let style: Omit<AnsiSegment, 'text'> = { bold: false }
	let last = 0
	for (const escape of text.matchAll(ANSI)) {
		if (escape.index > last) segments.push({ text: text.slice(last, escape.index), ...style })
		last = escape.index + escape[0].length
		if (escape[0].endsWith('m')) style = applySgr(style, escape[0].slice(2, -1))
	}
	if (last < text.length) segments.push({ text: text.slice(last), ...style })
	return segments
}

function applySgr(style: Omit<AnsiSegment, 'text'>, params: string) {
	let { color, bold } = style
	const codes = params.split(';').map(Number)
	for (let code = codes.shift(); code !== undefined; code = codes.shift()) {
		if (code === 0) {
			color = undefined
			bold = false
		} else if (code === 1) bold = true
		else if (code === 22) bold = false
		else if (code === 39) color = undefined
		else if (code >= 30 && code <= 37) color = ANSI_COLORS[code - 30]
		else if (code >= 90 && code <= 97) color = ANSI_COLORS[code - 82]
		else if (code === 38 || code === 48) {
			// 38 sets the foreground, 48 the background we do not draw; both carry 5;n or 2;r;g;b.
			const extended = codes.shift() === 5 ? xterm256(codes.shift()) : rgb(codes.splice(0, 3))
			if (code === 38) color = extended
		}
	}
	return { color, bold }
}

function xterm256(index: number | undefined) {
	if (index === undefined) return undefined
	if (index < 16) return ANSI_COLORS[index]
	if (index >= 232) {
		const gray = 8 + 10 * (index - 232)
		return rgb([gray, gray, gray])
	}
	const cube = index - 16
	const levels = [Math.floor(cube / 36), Math.floor(cube / 6) % 6, cube % 6]
	return rgb(levels.map(level => (level === 0 ? 0 : 55 + 40 * level)))
}

const rgb = (channels: number[]) => `rgb(${channels.join(' ')})`

const BUILD_STEP = /^#(?<id>\d+) (?<stage>\[[^\]]+\]) (?<command>.+)$/u
const BUILD_OUTPUT = /^#(?<id>\d+) (?:(?<elapsed>\d+\.\d+) )?(?<text>.*)$/u
const BUILD_RESULT = /^(?:DONE (?<seconds>[\d.]+s)|(?<cached>CACHED)|ERROR\b)/u

/** Reads BuildKit's plain progress: `#18 [web builder 7/7] RUN …` opens step 18 and `#18 0.740 …` is its output. */
export function parseBuildLine(text: string) {
	const step = BUILD_STEP.exec(text)?.groups
	if (step) {
		const { id = '', stage = '', command = '' } = step
		return { kind: 'step' as const, id, stage, command }
	}
	const output = BUILD_OUTPUT.exec(text)?.groups
	if (!output) return null
	const { id = '', elapsed = '', text: rest = '' } = output
	return { kind: 'output' as const, id, elapsed, text: rest }
}

export type BuildResult = { failed: boolean; label: string }

/** Reads the output that closes a BuildKit step: `DONE 0.7s`, `CACHED` or `ERROR: …`. */
export function parseBuildResult(output: string): BuildResult | null {
	const result = BUILD_RESULT.exec(output)?.groups
	if (!result) return null
	if (result.seconds) return { failed: false, label: result.seconds }
	if (result.cached) return { failed: false, label: 'cached' }
	return { failed: true, label: 'failed' }
}
