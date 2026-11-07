import { expect, test } from 'bun:test'
import { bytesTick } from '../lib/format'
import { ratesOf, totalOf } from './metric-chart'
import { binaryScale } from './ui/line-chart'

const total = (sample: { at: number; total: number }) => sample.total
const ticks = (high: number) => binaryScale(0, high).ticks.map(bytesTick)

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

test('a byte axis steps in whole binary units, also just under the next one', () => {
	expect(ticks(14.3 * 1024 ** 2)).toEqual(['0 B', '5 MB', '10 MB', '15 MB'])
	expect(ticks(1023)).toEqual(['0 B', '256 B', '512 B', '768 B', '1 KB'])
	expect(ticks(1010 * 1024 ** 2)).toEqual(['0 B', '256 MB', '512 MB', '768 MB', '1 GB'])
	expect(ticks(999 * 1024)).toEqual(['0 B', '256 KB', '512 KB', '768 KB', '1 MB'])
})
