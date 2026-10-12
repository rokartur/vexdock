import { expect, test } from 'bun:test'
import type { HostPort, ServicePort } from '../lib/api'
import { portRows } from './service-routing'

const stored = (id: string, published: number, target = 5432): ServicePort => ({
	id,
	service_id: 'svc',
	published,
	target,
	protocol: 'tcp',
	created_at: '2026-10-12T00:00:00Z',
})
const live = (published: number, target = 5432, ip = '0.0.0.0'): HostPort => ({
	ip,
	published,
	target,
	protocol: 'tcp',
})

test('a stored port the container publishes is open', () => {
	expect(portRows([stored('a', 5403)], [live(5403), live(5403, 5432, '::')])).toEqual([
		{ id: 'a', published: 5403, target: 5432, protocol: 'tcp', state: 'open', storedId: 'a' },
	])
})

test('a stored port the container does not publish opens on deploy', () => {
	expect(portRows([stored('a', 5403)], [])[0]?.state).toBe('opens on deploy')
})

test('a port only the container holds is a row that closes on deploy, once per port', () => {
	expect(portRows([], [live(5403), live(5403, 5432, '::')])).toEqual([
		{ id: 'live:5403:5432/tcp', published: 5403, target: 5432, protocol: 'tcp', state: 'closes on deploy' },
	])
})

test('a stored port that moved its target is one row opening and one closing', () => {
	expect(portRows([stored('a', 5403, 5433)], [live(5403)]).map(row => [row.target, row.state])).toEqual([
		[5433, 'opens on deploy'],
		[5432, 'closes on deploy'],
	])
})

test('rows sort by published port', () => {
	expect(portRows([stored('b', 9000), stored('a', 8080)], [live(5403)]).map(row => row.published)).toEqual([
		5403, 8080, 9000,
	])
})
