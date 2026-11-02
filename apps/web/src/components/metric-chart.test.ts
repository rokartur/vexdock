import { expect, test } from 'bun:test'
import { ratesOf, totalOf } from './metric-chart'

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

test('never reports a negative rate or divides by a zero interval', () => {
	const history = [
		{ at: 1000, total: 900 },
		{ at: 1000, total: 900 },
		// A restarted container resets its counters.
		{ at: 2000, total: 10 },
	]

	expect(ratesOf(history, total).map(point => point.value)).toEqual([0, 0])
})

test('adds up a climbing counter, counting a restart from zero', () => {
	const history = [
		{ at: 1000, total: 100 },
		{ at: 2000, total: 400 },
		{ at: 3000, total: 50 },
		{ at: 4000, total: 150 },
	]

	expect(totalOf(history, total)).toBe(300 + 50 + 100)
	expect(totalOf([], total)).toBe(0)
})
