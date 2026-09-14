import { useState } from 'react'
import { IconEye, IconEyeOff, IconPlus, IconRefresh } from '@tabler/icons-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { DialogFooter } from '@/components/ui/dialog'
import { api, type Engine, type Service, type ServiceProvider } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { Button, ErrorText, Field, IconButton, Input, Textarea } from './primitives'

/**
 * What the menu asked for. An application is created as a bare name: whether it
 * builds from a repository or runs a published image is answered in its own
 * settings, once it exists and there is somewhere to answer it.
 */
export type ServiceKind = 'application' | 'database' | 'compose'

const titles: Record<ServiceKind, string> = {
	application: 'New application',
	database: 'New database',
	compose: 'New compose service',
}

const providers: Record<ServiceKind, ServiceProvider> = {
	application: 'unconfigured',
	database: 'image',
	compose: 'raw',
}

/** Hex, so it can never carry the whitespace or quotes the manager rejects. */
const generatePassword = () => crypto.randomUUID().replaceAll('-', '')

export function newServiceTitle(kind: ServiceKind) {
	return titles[kind]
}

/**
 * Adds one service of an already-chosen kind. Application and compose are thin
 * pass-throughs; a database is generated, so it asks for an engine and a
 * version and lets the manager write the rest.
 */
export function NewServiceForm({
	projectId,
	kind,
	onDone,
	onCancel,
}: {
	projectId: string
	kind: ServiceKind
	onDone: (service: Service) => void
	onCancel: () => void
}) {
	const [name, setName] = useState('')
	const [fragment, setFragment] = useState('')

	const [engine, setEngine] = useState('postgres')
	const [version, setVersion] = useState('')
	const [databaseName, setDatabaseName] = useState('app')
	const [user, setUser] = useState('app')
	const [image, setImage] = useState('')
	const [dataPath, setDataPath] = useState('')
	const [password, setPassword] = useState(generatePassword)
	const [revealed, setRevealed] = useState(false)

	const engines = useQuery({ queryKey: ['engines'], queryFn: api.engines, enabled: kind === 'database' })
	const selected = engines.data?.find(option => option.slug === engine)
	const isCustom = engine === 'custom'

	// The version list is a suggestion, not a constraint: the field stays free
	// text so a tag the registry has not published yet still works.
	const versions = useQuery({
		queryKey: ['engine-versions', engine],
		queryFn: () => api.engineVersions(engine),
		enabled: kind === 'database' && selected !== undefined && !isCustom,
	})

	const environmentId = useEnvironmentId()
	const create = useMutation({
		mutationFn: () =>
			api.createService(
				projectId,
				{
					name,
					provider: providers[kind],
					...(kind === 'compose' ? { compose_fragment: fragment } : {}),
					...(kind === 'database'
						? {
								database: {
									engine,
									version: version || undefined,
									name: databaseName || undefined,
									user: user || undefined,
									password,
									image: isCustom ? image : undefined,
									data_path: isCustom ? dataPath : undefined,
								},
							}
						: {}),
				},
				environmentId,
			),
		onSuccess: onDone,
	})

	return (
		<form
			onSubmit={event => {
				event.preventDefault()
				create.mutate()
			}}
		>
			{kind === 'database' ? (
				<Field label='Engine'>
					<EnginePicker
						engines={engines.data ?? []}
						value={engine}
						onChange={next => {
							setEngine(next)
							setVersion('')
						}}
					/>
				</Field>
			) : null}

			<div className='grid gap-x-6 md:grid-cols-2'>
				<Field label='Name' hint='Its name in compose, and how siblings reach it.'>
					<Input
						required
						value={name}
						onChange={event => setName(event.target.value)}
						placeholder={kind === 'database' ? 'db' : 'api'}
					/>
				</Field>

				{kind === 'database' ? (
					<>
						{isCustom ? (
							<>
								<Field label='Image' hint='Including the tag.'>
									<Input
										required
										value={image}
										onChange={event => setImage(event.target.value)}
										placeholder='clickhouse/clickhouse-server:24'
									/>
								</Field>
								<Field
									label='Data path'
									hint='Where the image stores its data. Without it a redeploy wipes the database.'
								>
									<Input
										required
										value={dataPath}
										onChange={event => setDataPath(event.target.value)}
										placeholder='/var/lib/clickhouse'
									/>
								</Field>
							</>
						) : (
							<Field
								label='Version'
								hint={
									versions.data?.live === false
										? 'Registry unreachable, showing the built-in list. Any tag can be typed.'
										: 'Read from the registry. Any tag can be typed.'
								}
							>
								<Input
									list='engine-versions'
									value={version}
									onChange={event => setVersion(event.target.value)}
									placeholder={selected?.default_tag ?? ''}
								/>
								<datalist id='engine-versions'>
									{(versions.data?.versions ?? selected?.versions ?? []).map(tag => (
										<option key={tag} value={tag}>
											{tag}
										</option>
									))}
								</datalist>
							</Field>
						)}

						{selected?.database_var ? (
							<Field label='Database'>
								<Input value={databaseName} onChange={event => setDatabaseName(event.target.value)} />
							</Field>
						) : null}
						{selected?.user_var ? (
							<Field label='User'>
								<Input value={user} onChange={event => setUser(event.target.value)} />
							</Field>
						) : null}
						{selected?.password_var ? (
							<Field
								label='Password'
								hint='Seeded into this service’s environment, where it can be changed later.'
							>
								<div className='flex items-center gap-1'>
									<Input
										required
										type={revealed ? 'text' : 'password'}
										value={password}
										onChange={event => setPassword(event.target.value)}
										spellCheck={false}
									/>
									<IconButton
										icon={IconRefresh}
										label='Regenerate'
										onClick={() => setPassword(generatePassword())}
									/>
									<IconButton
										icon={revealed ? IconEyeOff : IconEye}
										label={revealed ? 'Hide' : 'Reveal'}
										onClick={() => setRevealed(value => !value)}
									/>
								</div>
							</Field>
						) : null}
					</>
				) : null}
			</div>

			{kind === 'compose' ? (
				<Field
					label='Compose fragment'
					hint='The service body, without its name. Named volumes are declared for you. env_file: .env is the project environment.'
				>
					<Textarea
						required
						rows={6}
						value={fragment}
						onChange={event => setFragment(event.target.value)}
						spellCheck={false}
						placeholder={'image: redis:7\nrestart: unless-stopped'}
					/>
				</Field>
			) : null}

			{kind === 'application' ? (
				<p className='mb-3 text-label text-muted-foreground'>
					Where it comes from is set next, in the service&rsquo;s settings. It deploys once that is answered.
				</p>
			) : null}
			<ErrorText error={create.error} />
			<DialogFooter>
				<Button variant='ghost' onClick={onCancel}>
					Cancel
				</Button>
				<Button type='submit' variant='primary' disabled={create.isPending}>
					<IconPlus />
					{create.isPending ? 'Adding…' : 'Add service'}
				</Button>
			</DialogFooter>
		</form>
	)
}

/**
 * Brand marks for the catalog. Tabler ships only two of them, so all the marks
 * are inline paths instead, to keep one weight across the row. An engine
 * without one falls back to the generic database glyph.
 */
const marks: Record<string, { fill: string; d: string }> = {
	postgres: {
		fill: '#4d79a4',
		d: 'M12 2C7.6 2 4 4 4 8.5c0 3 .6 6.3 1.7 9 .7 1.8 1.5 3 2.4 3 .7 0 1-.5 1.3-1.4l.5-1.6c.3.1.7.2 1.1.2h.2c2 0 3.4-1.4 3.4-3.5 0-1.7-1.1-2.9-2.7-2.9-1 0-1.8.5-2.2 1.3.1-2 1.3-3.4 3.4-3.4 2.6 0 4.4 2 4.4 5 0 1.8-.5 3.4-1.2 4.5-.3.5-.1 1 .3 1.2.5.2 1 0 1.3-.5.9-1.4 1.5-3.4 1.5-5.6C20 5.4 16.7 2 12 2Z',
	},
	mysql: {
		fill: '#2c9bc9',
		d: 'M2.5 16c2-4.5 5.5-7.6 9.4-9.2-.6 1-.9 2-.9 3 2.5-2.4 5.6-4 8.9-4.4-2.4 1.9-4 4-4.8 6.3-.5 1.5-.5 2.6-.2 3.4.2.5.6 1 1.2 1.5.4.3.5.5.5.7 0 .4-.3.7-.9.7-.7 0-1.4-.4-2-1-.9-1-1.2-2.3-1-3.8-2.6 1.4-4.7 3.4-6.2 6-.2.3-.4.4-.7.4-.5 0-.9-.4-.9-.9 0-.2 0-.4.1-.6l1-2.1c-1 .6-2 1.4-2.9 2.3l-.6-2.3Z',
	},
	mariadb: {
		fill: '#9b9b9b',
		d: 'M22 6.5c-1.3 0-2.2.6-3 1.5-.8.9-1.4 1.4-2.6 1.4-2.6 0-4.3-1.1-7-1.1-3.5 0-6.4 2-7.4 5C1.4 15.4 2.6 18 5 18.6l-.8 1.4c-.2.3 0 .6.3.6h5c2.8 0 5-1.2 6.7-3.4 1.3-1.7 2-3 3.4-3.9 1.4-.9 2.4-1.9 2.4-4.4 0-1-.3-1.8-.6-2.2ZM6.6 12.3a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z',
	},
	mongodb: {
		fill: '#4faa41',
		d: 'M12 1.5c1.6 2.4 5 5.4 5 10.1 0 4-2.3 6.9-4.3 8.3l-.3 2.6h-.8l-.3-2.6C9.3 18.5 7 15.6 7 11.6c0-4.7 3.4-7.7 5-10.1Z',
	},
	valkey: {
		fill: '#c6332e',
		d: 'M12 3 2 6.8l10 3.8 10-3.8L12 3Zm10 6.4-10 3.8-10-3.8v1.9l10 3.8 10-3.8V9.4Zm0 4.2-10 3.8-10-3.8v1.9L12 19l10-3.8v-1.6Z',
	},
}

/**
 * The catalog as a list: one row per engine, with the image it will pull on the
 * right so the version can be sanity-checked before anything is picked.
 */
function EnginePicker({
	engines,
	value,
	onChange,
}: {
	engines: Engine[]
	value: string
	onChange: (slug: string) => void
}) {
	return (
		<div className='overflow-hidden rounded-lg border border-input'>
			{engines.map(engine => {
				const mark = marks[engine.slug]
				return (
					<button
						key={engine.slug}
						type='button'
						aria-pressed={engine.slug === value}
						onClick={() => onChange(engine.slug)}
						className='flex w-full items-center gap-2.5 border-b border-input px-2.5 py-2 text-body last:border-b-0 hover:bg-muted aria-pressed:bg-accent'
					>
						<svg className='size-4 shrink-0' viewBox='0 0 24 24' aria-hidden='true'>
							{mark ? (
								<path d={mark.d} fill={mark.fill} />
							) : (
								<path
									d='M3 4h18v16H3zM3 9h18M8 9v11'
									fill='none'
									stroke='currentColor'
									strokeWidth='1.6'
								/>
							)}
						</svg>
						{engine.name}
						<span className='ml-auto font-mono text-label text-muted-foreground'>
							{engine.repository
								? `${engine.repository.replace('library/', '')}:${engine.default_tag}`
								: 'any image'}
						</span>
					</button>
				)
			})}
		</div>
	)
}
