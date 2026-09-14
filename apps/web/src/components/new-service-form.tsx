import { useState } from 'react'
import { IconEye, IconEyeOff, IconPlus, IconRefresh } from '@tabler/icons-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { DialogFooter } from '@/components/ui/dialog'
import { api, type Engine, type Service, type ServiceProvider } from '../lib/api'
import { engineMarks } from '../lib/engine-marks'
import { useEnvironmentId } from '../lib/environment'
import { Button, ErrorText, Field, IconButton, Input, Select, Switch, Textarea } from './primitives'

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

/** What sqld can be started as. Only libSQL offers the choice. */
type SqldNode = 'primary' | 'replica' | 'standalone'

const sqldNodes: readonly { value: SqldNode; label: string }[] = [
	{ value: 'primary', label: 'Primary' },
	{ value: 'replica', label: 'Replica' },
	{ value: 'standalone', label: 'Standalone' },
]

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
	const [containerName, setContainerName] = useState('')
	const [fragment, setFragment] = useState('')

	const [engine, setEngine] = useState('postgres')
	const [version, setVersion] = useState('')
	const [databaseName, setDatabaseName] = useState('app')
	const [user, setUser] = useState('app')
	const [image, setImage] = useState('')
	const [dataPath, setDataPath] = useState('')
	const [password, setPassword] = useState(generatePassword)
	const [revealed, setRevealed] = useState(false)
	const [sqldNode, setSqldNode] = useState<SqldNode>('primary')
	const [sqldPrimaryURL, setSqldPrimaryURL] = useState('')
	const [sqldNamespaces, setSqldNamespaces] = useState(false)

	const engines = useQuery({ queryKey: ['engines'], queryFn: api.engines, enabled: kind === 'database' })
	const selected = engines.data?.find(option => option.slug === engine)
	const isCustom = engine === 'custom'
	// sqld has no database to name and keeps its credentials in one encoded
	// variable, so its fields are named here rather than derived from the
	// catalogue's user_var and password_var.
	const isLibsql = engine === 'libsql'

	// The version list is a suggestion, not a constraint: the field stays free
	// text so a tag the registry has not published yet still works.
	const versions = useQuery({
		queryKey: ['engine-versions', engine],
		queryFn: () => api.engineVersions(engine),
		enabled: kind === 'database' && selected !== undefined && !isCustom,
	})

	const environmentId = useEnvironmentId()
	// Both queries are the ones the project shell already runs, so this reads
	// the cache to show the name the manager would pick on its own.
	const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) })
	const environments = useQuery({ queryKey: ['environments', projectId], queryFn: () => api.environments(projectId) })
	const environment = environments.data?.find(candidate =>
		environmentId ? candidate.id === environmentId : candidate.is_default,
	)
	const derivedContainer =
		project.data && environment && name
			? [project.data.slug, environment.is_default ? '' : environment.slug, name].filter(Boolean).join('-')
			: ''

	const create = useMutation({
		mutationFn: () =>
			api.createService(
				projectId,
				{
					name,
					container_name: containerName || undefined,
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
									...(isLibsql
										? {
												sqld_node: sqldNode,
												sqld_primary_url: sqldNode === 'replica' ? sqldPrimaryURL : undefined,
												sqld_namespaces: sqldNamespaces,
											}
										: {}),
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
							setUser(next === 'libsql' ? 'libsql' : 'app')
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

				{kind === 'compose' ? null : (
					<Field label='Container name' hint='What docker ps shows.'>
						<Input
							value={containerName}
							onChange={event => setContainerName(event.target.value)}
							placeholder={derivedContainer}
							spellCheck={false}
						/>
					</Field>
				)}

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
						{isLibsql ? (
							<>
								<Field
									label='Node'
									hint='A replica follows a primary; a standalone replicates to nothing.'
								>
									<Select value={sqldNode} options={sqldNodes} onChange={setSqldNode} />
								</Field>
								{sqldNode === 'replica' ? (
									<Field label='Primary URL' hint='The gRPC address of the primary.'>
										<Input
											required
											value={sqldPrimaryURL}
											onChange={event => setSqldPrimaryURL(event.target.value)}
											placeholder='http://primary:5001'
											spellCheck={false}
										/>
									</Field>
								) : null}
							</>
						) : null}
						{selected?.user_var || isLibsql ? (
							<Field label='User'>
								<Input value={user} onChange={event => setUser(event.target.value)} />
							</Field>
						) : null}
						{selected?.password_var || isLibsql ? (
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

			{isLibsql ? (
				<div className='mb-3'>
					<Switch
						label='Namespaces'
						hint='Serve more than one database from this server.'
						checked={sqldNamespaces}
						onChange={setSqldNamespaces}
					/>
				</div>
			) : null}

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
				const mark = engineMarks[engine.slug]
				return (
					<button
						key={engine.slug}
						type='button'
						aria-pressed={engine.slug === value}
						onClick={() => onChange(engine.slug)}
						className='flex w-full items-center gap-2.5 border-b border-input px-2.5 py-2 text-body last:border-b-0 hover:bg-muted aria-pressed:bg-accent'
					>
						<svg className='size-4 shrink-0' viewBox={mark?.viewBox ?? '0 0 24 24'} aria-hidden='true'>
							{mark ? (
								<path d={mark.d} fill={mark.fill} fillRule={mark.fillRule} />
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
