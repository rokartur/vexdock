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
