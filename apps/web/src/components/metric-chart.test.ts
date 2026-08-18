import { expect, test } from 'bun:test'
import { curveThrough, ratesOf } from './metric-chart'

const total = (sample: { at: number; total: number }) => sample.total

test('turns a cumulative counter into per-second rates', () => {
	const history = [
		{ at: 1000, total: 0 },
		{ at: 2000, total: 500 },
		{ at: 4000, total: 1500 },
	]

	expect(ratesOf(history, total)).toEqual([
		{ at: 2000, value: 500 },
		{ at: 4000, value: 500 },
	])
})

test('smooths a spike without curving outside the samples', () => {
	const spike = [
		{ x: 0, y: 30 },
		{ x: 10, y: 30 },
		{ x: 20, y: 0 },
		{ x: 30, y: 30 },
	]
	const ys = [...curveThrough(spike).matchAll(/[\d.]+,(?<y>[\d.]+)/gu)].map(match => Number(match.groups?.y))

	expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
	expect(Math.max(...ys)).toBeLessThanOrEqual(30)
	expect(curveThrough(spike)).toContain('C')
})

test('never reports a negative rate or divides by a zero interval', () => {
	const history = [
		{ at: 1000, total: 900 },
		{ at: 1000, total: 900 },
		// A restarted container resets its counters.
		{ at: 2000, total: 10 },
	]

	expect(ratesOf(history, total).map(point => point.value)).toEqual([0, 0])
})
