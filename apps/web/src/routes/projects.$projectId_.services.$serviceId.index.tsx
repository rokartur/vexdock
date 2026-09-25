import { useState } from 'react'
import {
	IconBrandBitbucket,
	IconBrandDocker,
	IconBrandGit,
	IconBrandGithub,
	IconBrandGitlab,
	IconCup,
	IconDatabase,
	IconEye,
	IconEyeOff,
	IconFileCode,
	IconGitBranch,
	IconHammer,
	IconPlayerStop,
	IconPlug,
	IconRefresh,
	IconRocket,
	IconTerminal2,
	IconWorld,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
	Button,
	Combo,
	ErrorText,
	Fact,
	Facts,
	Field,
	FormSection,
	Input,
	RelativeTime,
	SaveButton,
	Segmented,
	Select,
	Status,
	Switch,
	Textarea,
} from '../components/primitives'
import { api, type BuildType, type CredentialKind, isGitProvider, type Service, type ServiceProvider } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { duration } from '../lib/format'
import { useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/')({
	component: ServiceGeneral,
})

const providerOptions = [
	{ value: 'github', label: 'GitHub', icon: IconBrandGithub },
	{ value: 'gitlab', label: 'GitLab', icon: IconBrandGitlab },
	{ value: 'bitbucket', label: 'Bitbucket', icon: IconBrandBitbucket },
	{ value: 'gitea', label: 'Gitea', icon: IconCup },
	{ value: 'git', label: 'Git URL', icon: IconBrandGit },
	{ value: 'image', label: 'Image', icon: IconBrandDocker },
	{ value: 'raw', label: 'Compose', icon: IconFileCode },
] as const satisfies readonly { value: ServiceProvider; label: string; icon: unknown }[]

const credentialOptions: { value: CredentialKind; label: string }[] = [
	{ value: 'none', label: 'Public repository' },
	{ value: 'token', label: 'Access token' },
	{ value: 'ssh_key', label: 'SSH private key' },
]

const buildTypeOptions = [
	{ value: 'dockerfile', label: 'Dockerfile', icon: IconBrandDocker },
	{ value: 'static', label: 'Static (SPA)', icon: IconWorld },
] as const satisfies readonly { value: BuildType; label: string; icon: unknown }[]

/** How it deploys, then what a database is reachable as, then where the code comes from. */
function ServiceGeneral() {
	const { projectId, serviceId } = Route.useParams()
	const service = useService(serviceId)

	// The form is seeded from the service, so it waits for the first read
	// instead of mounting empty and overwriting what it never loaded.
	if (!service.data) return null
	return (
		<>
			<DeploySection projectId={projectId} service={service.data} />
			{service.data.type === 'database' ? <DatabaseSections serviceId={serviceId} /> : null}
			{/* Remounts on switch, so the fields follow the service the URL names. The keys differ per section:
			    siblings sharing one key make React lose track of them and leave stale copies behind. */}
			<SourceSection key={`source:${service.data.id}`} service={service.data} />
			{isGitProvider(service.data.provider) ? (
				<BuildSection key={`build:${service.data.id}`} service={service.data} />
			) : null}
		</>
	)
}

function DeploySection({ projectId, service }: { projectId: string; service: Service }) {
	const environmentId = useEnvironmentId()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const deployments = useQuery({
		queryKey: ['deployments', projectId, environmentId],
		queryFn: () => api.deployments(projectId, environmentId),
	})
	const latest = deployments.data?.find(deployment => deployment.service_name === service.compose_service_name)
	const params = { projectId, serviceId: service.id }
	const running = service.state === 'running'

	const act = useMutation({
		mutationFn: (action: 'stop' | 'restart') => api.serviceAction(service.id, action),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', service.id] }),
	})
	const deploy = useMutation({
		mutationFn: () => api.deployService(service.id),
		onSuccess: async deployment => {
			await queryClient.invalidateQueries({ queryKey: ['service', service.id] })
			// The service's own deployments tab, so the log opens without leaving it.
			await navigate({
				to: '/projects/$projectId/services/$serviceId/deployments',
				params,
				search: previous => ({ ...previous, deployment: deployment.id }),
			})
		},
	})
	const switches = useMutation({
		mutationFn: (body: Parameters<typeof api.updateService>[1]) => api.updateService(service.id, body),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', service.id] }),
	})

	return (
		<FormSection
			title='Deploy'
			description='Run it, or stop it. The log opens under Deployments.'
			icon={IconRocket}
			hint='Auto deploy watches this service’s own repository and branch. Prune build cache sweeps the host’s dangling builder cache once this service finishes building.'
			aside={[
				{
					label: 'Last deploy',
					value: latest ? (
						<span className='inline-flex flex-wrap items-center gap-2'>
							<Link
								to='/projects/$projectId/services/$serviceId/deployments'
								params={params}
								search={{ deployment: latest.id }}
								className='underline-offset-4 hover:underline'
							>
								#{latest.number}
							</Link>
							<Status value={latest.status} />
							<RelativeTime at={latest.created_at} />
							<span>{duration(latest.started_at, latest.finished_at)}</span>
						</span>
					) : (
						'never'
					),
				},
			]}
		>
			<ErrorText error={deploy.error ?? act.error ?? switches.error} />
			<div className='flex flex-wrap items-center gap-2'>
				<Button
					variant='primary'
					onClick={() => deploy.mutate()}
					disabled={service.provider === 'unconfigured' || deploy.isPending}
				>
					<IconRocket />
					{deploy.isPending ? 'Starting…' : 'Deploy'}
				</Button>
				<Button onClick={() => act.mutate('restart')} disabled={!running || act.isPending}>
					<IconRefresh />
					Restart
				</Button>
				<Button variant='danger' onClick={() => act.mutate('stop')} disabled={!running || act.isPending}>
					<IconPlayerStop />
					Stop
				</Button>
				<Button render={<Link to='/projects/$projectId/services/$serviceId/terminal' params={params} />}>
					<IconTerminal2 />
					Open terminal
				</Button>
				<span className='ml-1 rounded-md border border-rule px-3 py-1.5'>
					<Switch
						label='Auto deploy'
						checked={service.auto_deploy}
						onChange={on => switches.mutate({ auto_deploy: on })}
					/>
				</span>
				<span className='rounded-md border border-rule px-3 py-1.5'>
					<Switch
						label='Prune build cache'
						checked={service.prune_build_cache}
						onChange={on => switches.mutate({ prune_build_cache: on })}
					/>
				</span>
			</div>
		</FormSection>
	)
}

/**
 * Credentials are read back out of the service's own environment and the image off the service itself, so both are
 * what the container will start with rather than what the catalog now defaults to.
 */
function DatabaseSections({ serviceId }: { serviceId: string }) {
	const [revealed, setRevealed] = useState(false)
	const connection = useQuery({
		queryKey: ['service', serviceId, 'database'],
		queryFn: () => api.serviceDatabase(serviceId),
	})

	const { data } = connection
	if (!data) return null

	const mask = (value: string) => (revealed ? value : '•'.repeat(12))
	const upgrades = data.versions.filter(tag => !data.image.endsWith(`:${tag}`))

	return (
		<>
			<FormSection
				title='Connection'
				description='Reachable under this hostname from every other service in this project.'
				icon={IconPlug}
				hint='The password is what the container was created with.'
				actions={
					<Button variant='ghost' onClick={() => setRevealed(value => !value)}>
						{revealed ? <IconEyeOff /> : <IconEye />}
						{revealed ? 'Hide' : 'Reveal'}
					</Button>
				}
			>
				<Facts>
					<Fact label='Host' value={data.host} />
					<Fact label='Port' value={data.port} />
					{data.database ? <Fact label='Database' value={data.database} /> : null}
					{data.user ? <Fact label='User' value={data.user} /> : null}
					{data.password ? <Fact label='Password' value={mask(data.password)} /> : null}
					{data.url ? (
						<Fact label='URL' value={revealed ? data.url : data.url.replace(data.password, '•••')} />
					) : null}
					{data.node ? <Fact label='Node' value={data.node} /> : null}
					{data.replication_url ? <Fact label='Replication URL' value={data.replication_url} /> : null}
				</Facts>
			</FormSection>
			<FormSection
				title='Engine'
				description='Change the image under Source, then Deploy to move versions.'
				icon={IconDatabase}
			>
				<Facts>
					<Fact label='Engine' value={data.engine} />
					<Fact label='Image' value={data.image} />
					<Fact label='Volume' value={data.data_volume} />
					<Fact label='Other tags' value={upgrades.slice(0, 4).join(', ') || '-'} />
				</Facts>
			</FormSection>
		</>
	)
}

function SourceSection({ service }: { service: Service }) {
	const queryClient = useQueryClient()
	const [image, setImage] = useState(service.image)
	const [repositoryUrl, setRepositoryUrl] = useState(service.repository_url)
	const [branch, setBranch] = useState(service.branch)
	const [registryUrl, setRegistryUrl] = useState(service.registry_url)
	const [registryUsername, setRegistryUsername] = useState(service.registry_username)
	const [registryPassword, setRegistryPassword] = useState('')
	const [fragment, setFragment] = useState(service.compose_fragment)
	const [credentialKind, setCredentialKind] = useState<CredentialKind>(service.credential_kind || 'none')
	const [credentialSecret, setCredentialSecret] = useState('')
	const [providerId, setProviderId] = useState(service.git_provider_id)
	// A connection names a repository as an owner and a name, not as a URL.
	const [repository, setRepository] = useState(service.repository ? `${service.owner}/${service.repository}` : '')

	// An application arrives here as a bare name, so this page is where it gets
	// answered, and it can be answered again later. A database's provider is
	// fixed: its volume and credentials were rendered from the engine.
	const [provider, setProvider] = useState<ServiceProvider>(
		service.provider === 'unconfigured' ? 'github' : service.provider,
	)
	const editable = service.type === 'application'
	const showing = editable ? provider : service.provider
	const git = isGitProvider(showing)

	// A connection replaces both the URL and the credential: it lists the
	// repositories it can clone, and its token is what clones them.
	const connections = useQuery({ queryKey: ['git-providers'], queryFn: api.gitProviders, enabled: git })
	const connectionOptions = [
		{ value: '', label: 'Repository URL' },
		...(connections.data ?? [])
			.filter(connection => connection.provider_type === showing && connection.connected)
			.map(connection => ({ value: connection.git_provider_id, label: connection.name })),
	]
	const repositories = useQuery({
		queryKey: ['git-repositories', providerId],
		queryFn: () => api.gitRepositories(providerId),
		enabled: providerId !== '',
	})
	const listed = repositories.data ?? []
	const repositoryOptions = [
		...listed.map(repo => ({ value: `${repo.owner}/${repo.name}`, label: `${repo.owner}/${repo.name}` })),
		// A repository the token stopped listing stays visible rather than
		// blanking a field the service still deploys from.
		...(repository && !listed.some(repo => `${repo.owner}/${repo.name}` === repository)
			? [{ value: repository, label: repository }]
			: []),
	]

	// Branches come from the repository that is actually selected, so the field
	// offers what the remote has instead of accepting a name that fails at clone
	// time. The owner can carry slashes on GitLab, so only the last one splits it.
	const cut = repository.lastIndexOf('/')
	const owner = cut === -1 ? '' : repository.slice(0, cut)
	const repositoryName = cut === -1 ? '' : repository.slice(cut + 1)
	const branches = useQuery({
		queryKey: ['git-branches', providerId, repository],
		queryFn: () => api.gitBranches(providerId, owner, repositoryName),
		enabled: providerId !== '' && repositoryName !== '',
	})
	const branchOptions = [
		...(branches.data ?? []).map(name => ({ value: name, label: name })),
		...(branch && !(branches.data ?? []).includes(branch) ? [{ value: branch, label: branch }] : []),
	]

	const save = useMutation({
		mutationFn: () =>
			api.updateService(service.id, {
				...(editable ? { provider } : {}),
				...(git
					? {
							branch: branch || 'main',
							git_provider_id: providerId,
							...(providerId === ''
								? {
										repository_url: repositoryUrl,
										credential_kind: credentialKind,
										// An empty secret keeps the stored one; the manager only
										// re-encrypts what it is actually given.
										...(credentialSecret === '' ? {} : { credential_secret: credentialSecret }),
									}
								: { owner, repository: repositoryName }),
						}
					: {}),
				...(showing === 'image' ? { image } : {}),
				...(editable && showing === 'image'
					? {
							registry_url: registryUrl,
							registry_username: registryUsername,
							...(registryPassword === '' ? {} : { registry_password: registryPassword }),
						}
					: {}),
				...(showing === 'raw' ? { compose_fragment: fragment } : {}),
			}),
		onSuccess: () => {
			setCredentialSecret('')
			setRegistryPassword('')
			void queryClient.invalidateQueries({ queryKey: ['service', service.id] })
		},
	})

	return (
		<FormSection
			title='Source'
			description='Where the code comes from.'
			icon={IconGitBranch}
			hint='Applied on the next deploy.'
			onSave={() => save.mutate()}
			actions={<SaveButton mutation={save} />}
		>
			<ErrorText error={save.error} />
			{/* The fields take the width of the provider tabs above them. Containment keeps their own intrinsic
			    width out of the measurement, so the tabs alone size the column. */}
			<div className={editable ? 'w-fit max-w-full' : undefined}>
				{editable ? (
					<div className='mb-4'>
						<Segmented
							value={provider}
							onChange={next => {
								setProvider(next)
								// A connection belongs to one host, so it cannot survive the switch.
								setProviderId('')
							}}
							options={providerOptions}
						/>
					</div>
				) : null}
				<div className={editable ? '[contain:inline-size]' : undefined}>
					{git ? (
						<>
							{connectionOptions.length > 1 || providerId !== '' ? (
								<Field label='Connection'>
									<Select value={providerId} onChange={setProviderId} options={connectionOptions} />
								</Field>
							) : null}
							<Field
								label='Repository'
								hint={providerId === '' ? undefined : (repositories.error?.message ?? undefined)}
							>
								{providerId === '' ? (
									<Input
										value={repositoryUrl}
										onChange={event => setRepositoryUrl(event.target.value)}
									/>
								) : (
									<Combo
										value={repository}
										disabled={repositories.isPending}
										placeholder={repositories.isPending ? 'Loading…' : 'Search repositories'}
										empty='No repositories'
										options={repositoryOptions}
										onChange={setRepository}
									/>
								)}
							</Field>
							<div className='grid gap-x-6 md:grid-cols-2'>
								<Field label='Branch' hint={branches.error?.message ?? undefined}>
									{branches.isSuccess ? (
										<Combo
											value={branch}
											placeholder='Search branches'
											empty='No branches'
											options={branchOptions}
											onChange={setBranch}
										/>
									) : (
										<Input value={branch} onChange={event => setBranch(event.target.value)} />
									)}
								</Field>
								{providerId === '' ? (
									<Field label='Credentials'>
										<Select
											value={credentialKind}
											onChange={setCredentialKind}
											options={credentialOptions}
										/>
									</Field>
								) : null}
								{providerId !== '' || credentialKind === 'none' ? null : (
									<Field
										label={credentialKind === 'token' ? 'Token' : 'Private key'}
										hint='Leave empty to keep the stored value.'
									>
										<Textarea
											rows={credentialKind === 'token' ? 1 : 5}
											value={credentialSecret}
											onChange={event => setCredentialSecret(event.target.value)}
										/>
									</Field>
								)}
							</div>
						</>
					) : null}
					{showing === 'image' ? (
						<Field
							label='Image'
							hint={
								service.type === 'database'
									? 'Changing the tag is how a database moves version.'
									: undefined
							}
						>
							<Input value={image} onChange={event => setImage(event.target.value)} />
						</Field>
					) : null}
					{editable && showing === 'image' ? (
						<div className='grid gap-x-6 md:grid-cols-2'>
							<Field label='Registry URL'>
								<Input
									value={registryUrl}
									placeholder='Docker Hub'
									onChange={event => setRegistryUrl(event.target.value)}
								/>
							</Field>
							<Field label='Username' hint='Leave empty for a public image.'>
								<Input
									value={registryUsername}
									autoComplete='off'
									onChange={event => setRegistryUsername(event.target.value)}
								/>
							</Field>
							<Field
								label='Password'
								hint={service.registry_username ? 'Leave empty to keep the stored value.' : undefined}
							>
								<Input
									type='password'
									autoComplete='new-password'
									value={registryPassword}
									onChange={event => setRegistryPassword(event.target.value)}
								/>
							</Field>
						</div>
					) : null}
				</div>
			</div>
			{showing === 'raw' ? (
				<Field label='Compose fragment'>
					<Textarea
						rows={10}
						value={fragment}
						onChange={event => setFragment(event.target.value)}
						spellCheck={false}
					/>
				</Field>
			) : null}
		</FormSection>
	)
}

function BuildSection({ service }: { service: Service }) {
	const queryClient = useQueryClient()
	const [buildType, setBuildType] = useState(service.build_type)
	const [buildPath, setBuildPath] = useState(service.build_path)
	const [dockerfile, setDockerfile] = useState(service.dockerfile)
	const [buildTarget, setBuildTarget] = useState(service.build_target)

	const save = useMutation({
		mutationFn: () =>
			api.updateService(service.id, {
				build_type: buildType,
				build_path: buildPath,
				dockerfile,
				build_target: buildTarget,
			}),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['service', service.id] }),
	})

	return (
		<FormSection
			title='Build'
			description='How the repository becomes an image.'
			icon={IconHammer}
			hint={
				buildType === 'static'
					? 'Runs the package.json build script if there is one, then serves the output with nginx on port 80; unknown paths fall back to index.html.'
					: 'Applied on the next deploy.'
			}
			onSave={() => save.mutate()}
			actions={<SaveButton mutation={save} />}
		>
			<ErrorText error={save.error} />
			<div className='mb-4'>
				<Segmented value={buildType} onChange={setBuildType} options={buildTypeOptions} />
			</div>
			<Field label={buildType === 'static' ? 'Root directory' : 'Context path'}>
				<Input value={buildPath} placeholder='.' onChange={event => setBuildPath(event.target.value)} mono />
			</Field>
			{buildType === 'dockerfile' ? (
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Dockerfile'>
						<Input
							value={dockerfile}
							placeholder='Dockerfile'
							onChange={event => setDockerfile(event.target.value)}
							mono
						/>
					</Field>
					<Field label='Build stage' hint='Empty builds the last stage.'>
						<Input
							value={buildTarget}
							placeholder='production'
							onChange={event => setBuildTarget(event.target.value)}
							mono
						/>
					</Field>
				</div>
			) : null}
		</FormSection>
	)
}
