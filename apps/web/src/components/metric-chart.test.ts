import { expect, test } from 'bun:test'
import { joinSeries, ratesOf } from './metric-chart'

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

test('joins series on the timestamp, in time order', () => {
	const received = [
		{ at: 2000, value: 1 },
		{ at: 1000, value: 3 },
	]
	const sent = [{ at: 1000, value: 7 }]

	expect(joinSeries([received, sent])).toEqual([
		{ at: 1000, s0: 3, s1: 7 },
		{ at: 2000, s0: 1 },
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
