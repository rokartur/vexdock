import { expect, test } from 'bun:test'
import { accessSummary, grantList, picksNothing } from './access'

const name = (id: string) => ({ p1: 'shop', p2: 'blog', p3: 'docs' })[id] ?? id

test('reads write and read grants back by project name', () => {
	expect(accessSummary('Claude', { full: false, grants: { p1: 'write', p2: 'read', p3: 'read' } }, name)).toBe(
		'Claude will deploy, exec and change variables in shop and read blog and docs. It cannot see other projects or the server.',
	)
})

test('full access says everything, whatever projects are ticked', () => {
	expect(accessSummary('Claude', { full: true, grants: { p1: 'read' } }, name)).toStartWith(
		'Claude will reach everything',
	)
})

test('an empty selection says nothing and is never sent as a grant list', () => {
	const empty = { full: false, grants: {} }
	expect(accessSummary('Claude', empty, name)).toBe('')
	expect(picksNothing(empty)).toBe(true)
	expect(grantList({ full: false, grants: { p1: 'write' } })).toEqual([{ project_id: 'p1', level: 'write' }])
})
