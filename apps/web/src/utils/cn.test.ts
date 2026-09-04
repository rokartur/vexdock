import { expect, test } from 'bun:test'
import { cn } from './cn'
test('type-scale tokens do not clobber a text colour', () => {
	expect(cn('text-primary-foreground', 'text-body')).toBe('text-primary-foreground text-body')
	expect(cn('text-sm', 'text-body')).toBe('text-body')
})
