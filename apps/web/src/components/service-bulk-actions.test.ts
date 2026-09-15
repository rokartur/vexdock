import { expect, test } from 'bun:test'
import { freeName } from './service-bulk-actions'

test('a duplicate takes the first name the environment has not used', () => {
	expect(freeName('web', new Set(['web']))).toBe('web-copy')
	expect(freeName('web', new Set(['web', 'web-copy']))).toBe('web-copy-2')
	expect(freeName('web', new Set(['web', 'web-copy', 'web-copy-2']))).toBe('web-copy-3')
})
