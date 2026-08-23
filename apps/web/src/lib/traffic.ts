import type { TrafficPoint } from './api'

/**
 * The analytics series leaves out buckets with no events, so joining its points
 * would draw traffic that never happened. This puts the empty buckets back.
 * `bucket` is the series' step in seconds, as reported by the manager.
 */
export function dense(series: TrafficPoint[], bucket: number): TrafficPoint[] {
	const [start] = series
	if (bucket < 1 || !start) {
		return series
	}

	const filled: TrafficPoint[] = []
	for (const point of series) {
		const previous = filled.at(-1)?.at ?? point.at - bucket
		for (let at = previous + bucket; at < point.at; at += bucket) {
			filled.push({ at, views: 0, visitors: 0 })
		}
		filled.push(point)
	}

	// A lone bucket is not a line yet; the empty one before it gives a curve its start.
	return filled.length > 1 ? filled : [{ at: start.at - bucket, views: 0, visitors: 0 }, ...filled]
}

/**
 * Change against the window before, as a signed percentage. A period nobody
 * visited has no trend to report: coming from zero is not "up 100%".
 */
export function delta(current: number, previous: number): string | undefined {
	if (previous === 0) {
		return undefined
	}
	const change = Math.round(((current - previous) / previous) * 100)
	return change > 0 ? `+${change}%` : `${change}%`
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Folds hourly buckets into weekday × hour views, in the browser's timezone.
 * Rows start on Monday; every row has 24 hours whether they were busy or not.
 */
export function weekdayHours(series: TrafficPoint[]): number[][] {
	const grid = WEEKDAYS.map(() => Array.from<number>({ length: 24 }).fill(0))
	for (const point of series) {
		const at = new Date(point.at * 1000)
		const row = grid[(at.getDay() + 6) % 7]
		const hour = at.getHours()
		if (row) {
			row[hour] = (row[hour] ?? 0) + point.views
		}
	}
	return grid
}
