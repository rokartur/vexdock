import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api, type EnvVar } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { Button, Check, ErrorText, Field } from './primitives'

/** The sources a service can be created with. A derived service is the project's
 * own compose file talking, so it never travels on its own. */
const importableSources = ['unconfigured', 'git', 'image', 'compose'] as const
type ImportableSource = (typeof importableSources)[number]

/** One service as it travels between projects. Mirrors projects.PortableService. */
type PortableService = {
	name: string
	source_type: ImportableSource
	repository_url?: string
	branch?: string
	build_path?: string
	image?: string
	engine?: string
	data_path?: string
	compose_fragment?: string
	env?: { key: string; value: string; is_secret: boolean }[]
}

type Export = { version: number; project: string; services: PortableService[] }

/**
 * Reads a pasted export without trusting it. Everything here is a display
 * decision; the manager validates each service again on the way in, so a
 * hand-edited blob fails at creation rather than slipping through.
 */
export function decodeExport(pasted: string): Export | Error {
	const trimmed = pasted.trim()
	if (!trimmed) {
		return new Error('empty')
	}
	try {
		// atob yields a binary string, one byte per char, which TextDecoder then
		// reads as the UTF-8 the manager encoded. Code points would be wrong here.
		// oxlint-disable-next-line unicorn/prefer-code-point
		const bytes = Uint8Array.from(atob(trimmed), character => character.charCodeAt(0))
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
		if (typeof parsed !== 'object' || parsed === null) {
			throw new Error('not an object')
		}
		const candidate = parsed as Partial<Export>
		if (
			!Array.isArray(candidate.services) ||
			candidate.services.some(service => !service?.name || !importableSources.includes(service.source_type))
		) {
			throw new Error('no services')
		}
		if (candidate.version !== 1) {
			return new Error(`this export is version ${String(candidate.version)}; this vexdock reads version 1`)
		}
		return { version: 1, project: candidate.project ?? 'unknown', services: candidate.services }
	} catch {
		return new Error('That is not a vexdock export. Copy it from a project\u2019s settings, unedited.')
	}
}

/**
 * Lays an export's variables over the ones creating the service generated.
 *
 * Saving an environment replaces it, so the naive replay would delete a fresh
 * database password whenever the export was taken without secrets. Withheld
 * values therefore defer: where the create seeded the same key, the masked row
 * goes back untouched and the manager reads that as “unchanged”; where it did
 * not, the key still lands, empty, so its name is there to fill in.
 */
export function mergeEnv(seeded: EnvVar[], service: PortableService): EnvVar[] {
	const merged = [...seeded]
	for (const variable of service.env ?? []) {
		const at = merged.findIndex(existing => existing.key === variable.key)
		if (variable.value === '' && at !== -1) {
			continue
		}
		const row = { key: variable.key, value: variable.value, is_secret: variable.is_secret, updated_at: '' }
		if (at === -1) {
			merged.push(row)
		} else {
			merged[at] = row
		}
	}
	return merged
}

export function ImportServicesForm({
	projectId,
	existingNames,
	onDone,
	onCancel,
}: {
	projectId: string
	existingNames: string[]
	onDone: () => void
	onCancel: () => void
}) {
	const [pasted, setPasted] = useState('')
	const [skipped, setSkipped] = useState<string[]>([])

	const environmentId = useEnvironmentId()
	const decoded = useMemo(() => decodeExport(pasted), [pasted])
	const parsed = decoded instanceof Error ? null : decoded

	const taken = useMemo(() => new Set(existingNames), [existingNames])
	const importable = (parsed?.services ?? []).filter(
		service => !taken.has(service.name) && !skipped.includes(service.name),
	)
	const withheldSecrets = (parsed?.services ?? []).some(service =>
		(service.env ?? []).some(variable => variable.is_secret && variable.value === ''),
	)

	// Services are created one at a time through the same endpoint the forms
	// use, so each one is validated exactly as if it had been typed. Sequential
	// on purpose: every create rewrites the project's overlay, and in parallel
	// they would race for that one file. A failure half way leaves the earlier
	// ones in place, named in the error.
	const run = useMutation({
		mutationFn: async () => {
			/* oxlint-disable no-await-in-loop -- sequential is the point, see above */
			for (const service of importable) {
				try {
					const created = await api.createService(
						projectId,
						{
							name: service.name,
							source_type: service.source_type,
							repository_url: service.repository_url,
							branch: service.branch,
							build_path: service.build_path,
							image: service.engine ? undefined : service.image,
							compose_fragment: service.compose_fragment,
							database: service.engine
								? { engine: service.engine, image: service.image, data_path: service.data_path }
								: undefined,
						},
						environmentId,
					)
					const seeded = await api.serviceVariables(created.id)
					await api.saveServiceVariables(created.id, mergeEnv(seeded, service))
				} catch (error) {
					throw new Error(`${service.name}: ${error instanceof Error ? error.message : String(error)}`, {
						cause: error,
					})
				}
			}
			/* oxlint-enable no-await-in-loop */
		},
		onSuccess: onDone,
	})

	return (
		<form
			onSubmit={event => {
				event.preventDefault()
				run.mutate()
			}}
		>
			<Field label='Export' hint='Copied from another project’s settings.'>
				<textarea
					required
					rows={4}
					value={pasted}
					onChange={event => setPasted(event.target.value)}
					className='font-mono break-all'
					placeholder='eyJ2ZXJzaW9uIjoxLCJzZXJ2aWNlcyI6W119'
				/>
			</Field>

			{decoded instanceof Error && decoded.message !== 'empty' ? (
				<p className='mb-3 text-label text-destructive'>{decoded.message}</p>
			) : null}

			{parsed ? (
				<div className='mb-3'>
					<p className='mb-2 text-label text-muted-foreground'>
						{parsed.services.length} service{parsed.services.length === 1 ? '' : 's'} from {parsed.project}
					</p>
					<div className='rounded-xl border border-border px-3'>
						{parsed.services.map(service => {
							const collides = taken.has(service.name)
							const on = !collides && !skipped.includes(service.name)
							return (
								<div
									key={service.name}
									className={`flex items-center gap-3 border-b border-border py-1.5 text-body last:border-0 ${collides ? 'opacity-40' : ''}`}
								>
									<Check
										label={service.name}
										checked={on}
										disabled={collides}
										onChange={next =>
											setSkipped(current =>
												next
													? current.filter(name => name !== service.name)
													: [...current, service.name],
											)
										}
									/>
									<span className='truncate font-mono text-label text-muted-foreground'>
										{service.image || service.repository_url || service.source_type}
									</span>
									<span className='ml-auto shrink-0 text-label text-muted-foreground'>
										{collides ? 'name taken' : `${(service.env ?? []).length} vars`}
									</span>
								</div>
							)
						})}
					</div>
					{withheldSecrets ? (
						<p className='mt-2 text-label text-muted-foreground'>
							Some secrets were exported without their values. Fill them in after importing.
						</p>
					) : null}
				</div>
			) : null}

			<ErrorText error={run.error} />
			<div className='flex gap-2'>
				<Button type='submit' variant='primary' disabled={run.isPending || importable.length === 0}>
					{run.isPending ? 'Importing…' : `Import ${importable.length || ''}`.trim()}
				</Button>
				<Button variant='ghost' onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</form>
	)
}
