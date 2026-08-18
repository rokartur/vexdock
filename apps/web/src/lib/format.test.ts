import { expect, test } from 'bun:test'
import { parseAccessLine, parseLogLine } from './format'

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
	expect(line.level).toBe('error')
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
