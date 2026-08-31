import { expect, test } from 'bun:test'
import { readableOn } from './brand'

test('picks the label colour a custom accent can actually be read on', () => {
	expect(readableOn('#e16540')).toBe('#ffffff')
	expect(readableOn('#000000')).toBe('#ffffff')
	expect(readableOn('#ffffff')).toBe('#000000')
	// A pale accent is exactly the case the shipped white would fail.
	expect(readableOn('#facc15')).toBe('#000000')
})
