import { describe, expect, test } from 'bun:test'
import { readingOf } from './animated-number'

describe('readingOf', () => {
	test('keeps the unit and the decimals around the number', () => {
		expect(readingOf('1.53 GB')).toEqual({ prefix: '', integer: '1', fraction: '53', suffix: ' GB' })
		expect(readingOf('12%')).toEqual({ prefix: '', integer: '12', fraction: '', suffix: '%' })
	})

	test('a reading without digits stays text', () => {
		expect(readingOf('-')).toBeNull()
	})
})
