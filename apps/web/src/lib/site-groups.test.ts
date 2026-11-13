import { expect, test } from 'bun:test'
import type { AnalyticsSite } from './api'
import { groupSites } from './site-groups'

const site = (id: string, hostname: string, visitors: number) =>
	({ domain: { id, hostname }, visitors, hourly: [visitors, 0] }) as AnalyticsSite

test('files subdomains under the shortest listed parent and sums the group', () => {
	const groups = groupSites([
		site('a', 'agent.rokartur.com', 3),
		site('d', 'deep.agent.rokartur.com', 1),
		site('r', 'rokartur.com', 10),
		site('x', 'notrokartur.com', 2),
	])
	expect(
		groups.map(group => [
			group.domain.id,
			group.visitors,
			group.hourly,
			group.subdomains?.map(sub => sub.domain.id),
		]),
	).toEqual([
		['r', 14, [14, 0], ['a', 'd']],
		['x', 2, [2, 0], undefined],
	])
})

test('leaves subdomains apart when their parent is not listed', () => {
	const groups = groupSites([site('a', 'a.example.com', 1), site('b', 'b.example.com', 1)])
	expect(groups.map(group => group.subdomains)).toEqual([undefined, undefined])
})
