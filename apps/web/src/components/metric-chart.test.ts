import { expect, test } from 'bun:test'
import { joinSeries, ratesOf, sparkPath } from './metric-chart'

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

test('draws a sparkline without a peak, a run or a reading to scale by', () => {
	// Nothing recorded yet, and one reading has no run to spread over.
	expect(sparkPath([], 40, 10)).toBe('')
	expect(sparkPath([7], 40, 10)).toBe('M0,1 L40,1')
	// Every reading zero would divide by a zero peak; it sits on the floor instead.
	expect(sparkPath([0, 0, 0], 40, 10)).toBe('M0.0,9 L20.0,9 L40.0,9')
	// A fixed ceiling reads level: half of 100 is the middle of the box.
	expect(sparkPath([0, 50, 100], 40, 10, 100)).toBe('M0.0,9 L20.0,5 L40.0,1')
	// Above the ceiling clamps rather than drawing outside the box.
	expect(sparkPath([200, 200], 40, 10, 100)).toBe('M0.0,1 L40.0,1')
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
