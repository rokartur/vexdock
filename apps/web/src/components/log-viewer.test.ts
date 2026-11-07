import { expect, test } from 'bun:test'
import { outputLines, severityOf } from './log-viewer'

const stdout = (text: string) => severityOf({ stream: 'stdout', text })
const texts = (output: string) => outputLines(output).map(line => line.text)

test('reads a line severity off the level word, the status class or the stream', () => {
	expect(stdout('2026-08-18T10:33:13Z WARN disk almost full')).toBe('warn')
	expect(stdout('2026-08-18T10:33:13Z fatal: cannot bind :80')).toBe('error')
	expect(severityOf({ stream: 'stderr', text: 'nothing alarming in the words' })).toBe('error')
	// nginx writes its startup notices to stderr; the level word outranks the stream.
	expect(severityOf({ stream: 'stderr', text: '2026/11/06 13:36:52 [notice] 1#1: start worker processes' })).toBe(
		'info',
	)

	// An access line has no level word, so its status class is the severity.
	const access = (status: string) =>
		stdout(`10.0.0.1 - - [18/Aug/2026:10:33:13 +0000] "GET /cart HTTP/1.1" ${status} 812`)
	expect(access('500')).toBe('error')
	expect(access('404')).toBe('warn')
	expect(access('200')).toBeUndefined()

	// Nothing to go on is not an error; it must not be filtered as one.
	expect(stdout('listening on :3000')).toBeUndefined()
})

test('recorded output keeps its blank lines and drops only the final newline', () => {
	expect(texts('')).toEqual([])
	expect(texts('one\n\ntwo\n')).toEqual(['one', '', 'two'])
	expect(texts('\n\n')).toEqual(['', ''])
})
