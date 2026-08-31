import { describe, expect, test } from 'bun:test'
import { decodeExport, mergeEnv } from './import-services-form'

/** Stands in for the manager: UTF-8 bytes, then base64. Bytes, not code points. */
// oxlint-disable-next-line unicorn/prefer-code-point
const encode = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))

const service = (env: { key: string; value: string; is_secret: boolean }[]) => ({
	name: 'db',
	provider: 'image' as const,
	env,
})

const seed = (key: string, value: string) => ({ key, value, is_secret: true, updated_at: '' })

describe('decodeExport', () => {
	// The manager encodes UTF-8; atob hands back one byte per char. Reading
	// those as code points would mangle every non-ASCII value in transit.
	test('reads a payload the manager wrote, non-ASCII values intact', () => {
		const services = [
			{
				name: 'api',
				provider: 'github' as const,
				env: [{ key: 'GREETING', value: 'cześć → 你好', is_secret: false }],
			},
		]
		const decoded = decodeExport(encode({ version: 2, project: 'usagefleet', services }))
		expect(decoded).toEqual({ version: 2, project: 'usagefleet', services })
	})

	test('rejects a payload whose services claim a provider that cannot be created', () => {
		const decoded = decodeExport(encode({ version: 2, services: [{ name: 'web', provider: 'derived' }] }))
		expect(decoded).toBeInstanceOf(Error)
	})

	test('names the version rather than the paste when it is one it cannot read', () => {
		const decoded = decodeExport(encode({ version: 1, services: [{ name: 'api', provider: 'github' }] }))
		expect((decoded as Error).message).toContain('version 2')
	})

	test('anything that is not an export is one error, not a crash', () => {
		expect(decodeExport('hello')).toBeInstanceOf(Error)
		expect(decodeExport(btoa('{}'))).toBeInstanceOf(Error)
	})
})

describe('mergeEnv', () => {
	// The one that matters: saving an environment replaces it, so a withheld
	// secret must defer to the password the create just generated.
	test('a withheld secret leaves the generated one alone', () => {
		const merged = mergeEnv(
			[seed('POSTGRES_PASSWORD', '••••••••')],
			service([{ key: 'POSTGRES_PASSWORD', value: '', is_secret: true }]),
		)
		expect(merged).toEqual([seed('POSTGRES_PASSWORD', '••••••••')])
	})

	test('a withheld secret with nothing to defer to still lands, so its name is there', () => {
		const merged = mergeEnv([], service([{ key: 'STRIPE_KEY', value: '', is_secret: true }]))
		expect(merged).toEqual([{ key: 'STRIPE_KEY', value: '', is_secret: true, updated_at: '' }])
	})

	test('an exported value wins over the generated one', () => {
		const merged = mergeEnv(
			[seed('POSTGRES_PASSWORD', '••••••••')],
			service([{ key: 'POSTGRES_PASSWORD', value: 's3cret', is_secret: true }]),
		)
		expect(merged).toEqual([{ key: 'POSTGRES_PASSWORD', value: 's3cret', is_secret: true, updated_at: '' }])
	})

	test('a generated key the export never heard of survives', () => {
		const merged = mergeEnv(
			[seed('POSTGRES_USER', 'app')],
			service([{ key: 'LOG_LEVEL', value: 'debug', is_secret: false }]),
		)
		expect(merged.map(variable => variable.key)).toEqual(['POSTGRES_USER', 'LOG_LEVEL'])
	})
})
