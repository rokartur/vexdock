import { describe, expect, test } from 'bun:test'
import { delta, dense, weekdayHours } from './traffic'

const point = (at: number, views: number) => ({ at, views, visitors: views })

describe('dense', () => {
	test('puts the quiet buckets back between two hits', () => {
		expect(dense([point(0, 3), point(2700, 1)], 900)).toEqual([
			point(0, 3),
			point(900, 0),
			point(1800, 0),
			point(2700, 1),
		])
	})

	test('gives a lone bucket an empty one to be a line from', () => {
		expect(dense([point(3600, 2)], 3600)).toEqual([point(0, 0), point(3600, 2)])
	})

	test('leaves an empty series and an unknown bucket alone', () => {
		expect(dense([], 900)).toEqual([])
		expect(dense([point(0, 1), point(90_000, 1)], 0)).toEqual([point(0, 1), point(90_000, 1)])
	})
})

describe('delta', () => {
	test('signs the change against the window before', () => {
		expect(delta(112, 100)).toBe('+12%')
		expect(delta(90, 100)).toBe('-10%')
	})

	test('reports no trend out of a period nobody visited', () => {
		expect(delta(40, 0)).toBeUndefined()
	})
})

describe('weekdayHours', () => {
	test('sums views into the local weekday and hour, Monday first', () => {
		// A Monday, 09:00 local.
		const monday = new Date(2024, 0, 1, 9)
		const grid = weekdayHours([
			{ at: monday.getTime() / 1000, views: 2, visitors: 2 },
			{ at: monday.getTime() / 1000 + 7 * 86_400, views: 3, visitors: 1 },
		])
		expect(grid).toHaveLength(7)
		expect(grid[0]?.[9]).toBe(5)
		expect(grid[0]?.filter(Boolean)).toHaveLength(1)
	})
})
