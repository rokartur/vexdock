import { describe, expect, test } from 'bun:test'
import { readingOf } from './animated-number'

describe('readingOf', () => {
	test('keeps the unit and the decimals around the number', () => {
		expect(readingOf('1.53 GB')).toEqual({ prefix: '', value: 1.53, decimals: 2, suffix: ' GB' })
		expect(readingOf('12%')).toEqual({ prefix: '', value: 12, decimals: 0, suffix: '%' })
	})

	test('a reading without digits stays text', () => {
		expect(readingOf('-')).toBeNull()
	})
})
