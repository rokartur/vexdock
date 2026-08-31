import { expect, test } from 'bun:test'
import { labelOf, trailOf } from './breadcrumb'

const routes = [
	'/',
	'/projects/',
	'/projects/$projectId',
	'/projects/$projectId/settings',
	'/docker/containers',
]

test('links every ancestor a route serves, never the current page', () => {
	expect(trailOf('/projects/abc/settings', routes)).toEqual([
		{ segment: 'projects', to: '/projects', linkable: true },
		{ segment: 'abc', to: '/projects/abc', linkable: true },
		{ segment: 'settings', to: '/projects/abc/settings', linkable: false },
	])
})

test('keeps ancestors that no route serves, unlinked', () => {
	expect(trailOf('/docker/containers', routes)).toEqual([
		{ segment: 'docker', to: '/docker', linkable: false },
		{ segment: 'containers', to: '/docker/containers', linkable: false },
	])
})

test('the root reads as the dashboard', () => {
	expect(trailOf('/', routes)).toEqual([{ segment: 'dashboard', to: '/', linkable: false }])
})

test('labels are title-cased', () => {
	expect(labelOf('backups')).toBe('Backups')
	expect(labelOf('docker-hub')).toBe('Docker hub')
})
