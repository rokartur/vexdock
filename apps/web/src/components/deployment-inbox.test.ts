import { expect, test } from 'bun:test'
import type { DeploymentStatus } from '../lib/api'
import { newlySettled } from './deployment-inbox'

const answer = (...deployments: [string, DeploymentStatus][]) =>
	deployments.map(([id, status]) => ({ deployment: { id, status } }))

test('the first answer is the baseline, so opening a tab replays nothing', () => {
	const first = newlySettled(null, answer(['a', 'success'], ['b', 'failed'], ['c', 'running']))
	expect([...first.fresh]).toEqual([])
	expect([...first.settled]).toEqual(['a', 'b'])
})

test('a deploy is fresh once, whether it was seen running or arrived already finished', () => {
	const first = newlySettled(null, answer(['a', 'success'], ['c', 'running']))
	const second = newlySettled(first.settled, answer(['d', 'cancelled'], ['a', 'success'], ['c', 'failed']))
	expect([...second.fresh].toSorted()).toEqual(['c', 'd'])
	const third = newlySettled(second.settled, answer(['e', 'queued'], ['d', 'cancelled'], ['c', 'failed']))
	expect([...third.fresh]).toEqual([])
})
