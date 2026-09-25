import { expect, test } from 'bun:test'
import { ansiSegments, parseAccessLine, parseBuildLine, parseBuildResult, parseLogLine, until } from './format'

const esc = String.fromCodePoint(27)

test('splits the engine timestamp off the message', () => {
	const line = parseLogLine('2026-08-18T10:33:13.123456789Z starting worker')

	expect(line.timestamp).toBe('2026-08-18T10:33:13.123456789Z')
	expect(line.body).toBe('starting worker')
	expect(line.time).toMatch(/^\d{2}:\d{2}:\d{2}$/u)
})

test('keeps lines that carry no timestamp intact', () => {
	const line = parseLogLine('plain output')

	expect(line.timestamp).toBeNull()
	expect(line.time).toBeNull()
	expect(line.body).toBe('plain output')
})

test('strips ANSI escapes and reads the severity word', () => {
	const line = parseLogLine(`2026-08-18T10:33:13Z ${esc}[31mERROR${esc}[0m connection refused`)

	expect(line.body).toBe('ERROR connection refused')
	expect(line.coloredBody).toBe(`${esc}[31mERROR${esc}[0m connection refused`)
	expect(line.level).toBe('error')
})

test('turns SGR codes into colored runs and drops other escapes', () => {
	expect(ansiSegments(`${esc}[1;33m[WARN]${esc}[0m ${esc}[38;5;240m\u2502${esc}[39m${esc}[2K done`)).toEqual([
		{ text: '[WARN]', color: '#fbbf24', bold: true },
		{ text: ' ', color: undefined, bold: false },
		{ text: '\u2502', color: 'rgb(88 88 88)', bold: false },
		{ text: ' done', color: undefined, bold: false },
	])
	expect(ansiSegments(`${esc}[38;5;115mok`)).toEqual([{ text: 'ok', color: 'rgb(135 215 175)', bold: false }])
})

test('reads BuildKit steps, their output and how they closed', () => {
	expect(parseBuildLine('#18 [web builder 7/7] RUN bun run build')).toEqual({
		kind: 'step',
		id: '18',
		stage: '[web builder 7/7]',
		command: 'RUN bun run build',
	})
	expect(parseBuildLine('#18 0.740 migrate.cjs  253.6kb')).toEqual({
		kind: 'output',
		id: '18',
		elapsed: '0.740',
		text: 'migrate.cjs  253.6kb',
	})
	expect(parseBuildLine('#24 exporting layers')).toEqual({
		kind: 'output',
		id: '24',
		elapsed: '',
		text: 'exporting layers',
	})
	expect(parseBuildLine(' web  Built')).toBeNull()
	expect(parseBuildResult('DONE 0.7s')).toEqual({ failed: false, label: '0.7s' })
	expect(parseBuildResult('CACHED')).toEqual({ failed: false, label: 'cached' })
	expect(parseBuildResult('ERROR: process "/bin/sh -c bun run build" did not complete')).toEqual({
		failed: true,
		label: 'failed',
	})
	expect(parseBuildResult('exporting layers 0.3s done')).toBeNull()
})

test('matches severity case-insensitively and only as a whole word', () => {
	expect(parseLogLine('[warn] disk almost full').level).toBe('warn')
	expect(parseLogLine('information about the run').level).toBeNull()
})

test('breaks an nginx access line into columns', () => {
	const request = parseAccessLine(
		'192.168.127.1 - - [18/Aug/2026:10:38:01 +0000] "GET /api/docker/containers HTTP/1.1" 200 3916 "http://localhost:5174/" "Mozilla/5.0" "-"',
	)

	expect(request).toEqual({
		client: '192.168.127.1',
		method: 'GET',
		path: '/api/docker/containers',
		status: '200',
		bytes: 3916,
	})
})

test('leaves non-access lines to the plain renderer', () => {
	expect(parseAccessLine('2026/08/18 10:33:13 [error] 12#12: *5 open() failed')).toBeNull()
})

test('counts down to a stamp given as an ISO string or as unix seconds', () => {
	const target = Date.now() + 2 * 3600 * 1000 + 60_000

	expect(until(new Date(target).toISOString())).toBe('in 2h')
	expect(until(Math.floor(target / 1000))).toBe('in 2h')
	expect(until(Math.floor(Date.now() / 1000) - 60)).toBe('in 0s')
})
