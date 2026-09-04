import { useState } from 'react'
import { IconPlus } from '@tabler/icons-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { DialogFooter } from '@/components/ui/dialog'
import { api, type Service, type ServiceProvider } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { Button, ErrorText, Field, Input, Select, Textarea } from './primitives'

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
						<Field label='Engine'>
							<Select
								value={engine}
								onChange={next => {
									setEngine(next)
									setVersion('')
								}}
								options={(engines.data ?? []).map(option => ({
									value: option.slug,
									label: option.name,
								}))}
							/>
						</Field>

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
			{kind === 'database' && !isCustom ? (
				<p className='mb-3 text-label text-muted-foreground'>
					The password is generated and stored in this service&rsquo;s environment.
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
