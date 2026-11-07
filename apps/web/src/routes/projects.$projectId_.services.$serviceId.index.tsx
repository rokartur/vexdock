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
	IconPlayerPlay,
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
	Confirm,
	Combo,
	ErrorText,
	Fact,
	Facts,
	Field,
	PendingReading,
	FormSection,
	FormSkeleton,
	Input,
	RelativeTime,
	SaveButton,
	Segmented,
	Select,
	Status,
	Switch,
	Textarea,
	textLink,
} from '../components/primitives'
import { api, type BuildType, type CredentialKind, isGitProvider, type Service, type ServiceProvider } from '../lib/api'
import { duration, maskUrlPassword } from '../lib/format'
import { deploymentsQuery, preloadServiceDeployments } from '../lib/queries'
import { useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/')({
	loader: ({ context: { queryClient }, params: { projectId, serviceId } }) =>
		preloadServiceDeployments(queryClient, projectId, serviceId),
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
	// instead of mounting empty and overwriting what it never loaded. A failed read is the layout's ErrorText.
	if (!service.data) {
		if (service.error) return null
		return <FormSkeleton label='Loading the service' cards={2} />
	}
	return (
		<>
			<DeploySection projectId={projectId} service={service.data} />
			{service.data.type === 'database' ? <DatabaseSections serviceId={serviceId} /> : null}
			<SourceSection service={service.data} />
			{isGitProvider(service.data.provider) ? <BuildSection service={service.data} /> : null}
		</>
	)
}

function DeploySection({ projectId, service }: { projectId: string; service: Service }) {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const deployments = useQuery(deploymentsQuery(projectId, service.environment_id, service.compose_service_name))
	const latest = deployments.data?.[0]
	const params = { projectId, serviceId: service.id }
	const running = service.state === 'running'
	// docker stop also cancels the restart policy of a crash-looping container, and is the one action Docker takes on a
	// paused one (Start and Restart are refused).
	const stoppable = running || service.state === 'restarting' || service.state === 'paused'
	// An empty state means no container yet, which only a deploy creates.
	const startable = service.state !== '' && !stoppable

	const act = useMutation({
		mutationFn: (action: 'start' | 'stop' | 'restart') => api.serviceAction(service.id, action),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', service.id] }),
	})
	const acting = act.isPending ? act.variables : undefined
	const unconfigured = service.provider === 'unconfigured'
	const deploy = useMutation({
		mutationFn: () => api.deployService(service.id),
		onSuccess: async deployment => {
			await queryClient.invalidateQueries({ queryKey: ['service', service.id] })
			await queryClient.invalidateQueries({ queryKey: ['deployments', params.projectId] })
			// The service's own deployments tab, so the log opens without leaving it.
			await navigate({
				to: '/projects/$projectId/services/$serviceId/deployments',
				params,
				search: { deployment: deployment.id },
			})
		},
	})
	const switches = useMutation({
		mutationFn: (body: Parameters<typeof api.updateService>[1]) => api.updateService(service.id, body),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', service.id] }),
	})
	// A switch shows what it was flipped to until the refetch lands.
	const switching = switches.isPending ? switches.variables : {}
	let waiting = ''
	if (unconfigured) waiting = 'Deploy waits for a source: pick one under Source below. '
	if (service.state === '') waiting += 'Restart and Stop wait for the first deploy to create a container. '
	else if (service.state === 'restarting')
		waiting += 'Restart waits while Docker restarts the container; Stop ends the loop. '
	else if (service.state === 'paused')
		waiting += 'It was paused outside Vexdock: Docker refuses Start and Restart, Stop works. '
	// A webhook deploys only a git source, and only a source with a build context leaves builder cache.
	const fromGit = isGitProvider(service.provider)
	const builds = fromGit || service.provider === 'raw'
	let hint = waiting
	if (fromGit) hint += 'Auto deploy watches this service’s own repository and branch. '
	if (builds)
		hint += 'Prune build cache sweeps the host’s dangling builder cache once this service finishes building.'

	return (
		<FormSection
			title='Deploy'
			icon={IconRocket}
			hint={hint.trim() || undefined}
			aside={[
				{
					label: 'Last deploy',
					value: latest ? (
						<span className='inline-flex flex-wrap items-center gap-2'>
							<Link
								to='/projects/$projectId/services/$serviceId/deployments'
								params={params}
								search={{ deployment: latest.id }}
								className={textLink}
							>
								#{latest.number}
							</Link>
							<Status run value={latest.status} />
							<RelativeTime at={latest.created_at} />
							{latest.started_at && latest.finished_at ? (
								<span className='whitespace-nowrap'>
									took {duration(latest.started_at, latest.finished_at)}
								</span>
							) : null}
						</span>
					) : deployments.isSuccess ? (
						<span className='text-muted'>Never</span>
					) : (
						<PendingReading label='the last deploy' failed={deployments.isError} />
					),
				},
			]}
		>
			<ErrorText error={deploy.error ?? act.error ?? switches.error} />
			<ErrorText error={deployments.error} />
			<div className='flex flex-wrap items-center gap-2'>
				<Button
					variant='primary'
					onClick={() => deploy.mutate()}
					disabled={unconfigured}
					loading={deploy.isPending}
				>
					<IconRocket size={16} stroke={1.75} />
					Deploy
				</Button>
				{startable ? (
					<Button onClick={() => act.mutate('start')} loading={acting === 'start'}>
						<IconPlayerPlay size={16} stroke={1.75} />
						Start
					</Button>
				) : (
					<Button
						onClick={() => act.mutate('restart')}
						disabled={!running || acting === 'stop'}
						loading={acting === 'restart'}
					>
						<IconRefresh size={16} stroke={1.75} />
						Restart
					</Button>
				)}
				<Confirm
					title={`Stop ${service.compose_service_name}?`}
					description='Anything it serves is offline until it starts again.'
					action='Stop service'
					icon={IconPlayerStop}
					onConfirm={() => act.mutate('stop')}
				>
					<Button disabled={!stoppable || acting === 'restart'} loading={acting === 'stop'}>
						<IconPlayerStop size={16} stroke={1.75} />
						Stop
					</Button>
				</Confirm>
				<Button render={<Link to='/projects/$projectId/services/$serviceId/terminal' params={params} />}>
					<IconTerminal2 size={16} stroke={1.75} />
					Open terminal
				</Button>
				{builds ? (
					<span className='flex w-full flex-wrap items-center gap-x-6 gap-y-2'>
						{fromGit ? (
							<Switch
								label='Auto deploy'
								checked={switching.auto_deploy ?? service.auto_deploy}
								disabled={switches.isPending}
								onChange={on => switches.mutate({ auto_deploy: on })}
							/>
						) : null}
						<Switch
							label='Prune build cache'
							checked={switching.prune_build_cache ?? service.prune_build_cache}
							disabled={switches.isPending}
							onChange={on => switches.mutate({ prune_build_cache: on })}
						/>
					</span>
				) : null}
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
	if (!data) {
		if (connection.error) return <ErrorText error={connection.error} />
		return <FormSkeleton label='Loading the connection' cards={2} />
	}

	const mask = (value: string) =>
		revealed ? (
			value
		) : (
			<>
				<span aria-hidden>{'•'.repeat(12)}</span>
				<span className='sr-only'>Hidden</span>
			</>
		)
	const upgrades = data.versions.filter(tag => !data.image.endsWith(`:${tag}`))

	return (
		<>
			<FormSection
				title='Connection'
				icon={IconPlug}
				hint='The password is what the container was created with.'
				actions={
					<Button variant='ghost' onClick={() => setRevealed(value => !value)}>
						{revealed ? <IconEyeOff size={16} stroke={1.75} /> : <IconEye size={16} stroke={1.75} />}
						{revealed ? 'Hide password' : 'Reveal password'}
					</Button>
				}
			>
				{/* The FormSection is the frame; a framed Facts inside it would be a card in a card. */}
				<Facts className='border-0 bg-transparent px-0'>
					<Fact label='Host' value={data.host} />
					<Fact label='Port' value={data.port} />
					{data.database ? <Fact label='Database' value={data.database} /> : null}
					{data.user ? <Fact label='User' value={data.user} /> : null}
					{data.password ? <Fact label='Password' value={mask(data.password)} /> : null}
					{data.url ? (
						<Fact
							label='URL'
							value={revealed ? data.url : maskUrlPassword(data.url, data.user, data.host)}
						/>
					) : null}
					{data.node ? <Fact label='Node' value={data.node} /> : null}
					{data.replication_url ? <Fact label='Replication URL' value={data.replication_url} /> : null}
				</Facts>
			</FormSection>
			<FormSection
				title='Engine'
				icon={IconDatabase}
				hint='Other tags are the versions Vexdock offers for this engine besides the one running.'
			>
				<Facts className='border-0 bg-transparent px-0'>
					<Fact label='Engine' value={data.engine} />
					<Fact label='Volume' value={data.data_volume} />
					<Fact label='Other tags' value={upgrades.join(', ') || '-'} />
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
	const savedCredentialKind: CredentialKind = service.credential_kind || 'none'
	const [credentialKind, setCredentialKind] = useState(savedCredentialKind)
	const [credentialSecret, setCredentialSecret] = useState('')
	const [providerId, setProviderId] = useState(service.git_provider_id)
	// A connection names a repository as an owner and a name, not as a URL.
	const savedRepository = service.repository ? `${service.owner}/${service.repository}` : ''
	const [repository, setRepository] = useState(savedRepository)

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
		// Arc's Select reads '' as nothing picked, so the URL choice travels as 'url' and is stored as ''.
		{ value: 'url', label: 'Repository URL' },
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

	// Compared the way the save sends them: an empty git branch is saved as main, and an application that was never
	// configured is unsaved until its provider is.
	const dirty =
		(editable && provider !== service.provider) ||
		(git ? branch || 'main' : branch) !== service.branch ||
		providerId !== service.git_provider_id ||
		repository !== savedRepository ||
		repositoryUrl !== service.repository_url ||
		credentialKind !== savedCredentialKind ||
		credentialSecret !== '' ||
		image !== service.image ||
		registryUrl !== service.registry_url ||
		registryUsername !== service.registry_username ||
		registryPassword !== '' ||
		fragment !== service.compose_fragment
	return (
		<FormSection
			title='Source'
			icon={IconGitBranch}
			hint='Applied on the next deploy.'
			onSave={() => save.mutate()}
			actions={<SaveButton mutation={save} dirty={dirty} />}
		>
			<ErrorText error={save.error} />
			{/* The fields take the width of the provider tabs above them. Containment keeps their own intrinsic
			    width out of the measurement, so the tabs alone size the column. */}
			<div className={editable ? 'w-fit max-w-full' : undefined}>
				{editable ? (
					<div className='mb-4'>
						<Segmented
							label='Source'
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
							{/* Without the list, the connection picker below cannot offer the saved ones. */}
							<ErrorText error={connections.error} />
							{connectionOptions.length > 1 || providerId !== '' ? (
								<Field label='Connection'>
									<Select
										value={providerId || 'url'}
										onChange={next => setProviderId(next === 'url' ? '' : next)}
										options={connectionOptions}
									/>
								</Field>
							) : null}
							<ErrorText error={repositories.error} />
							<ErrorText error={branches.error} />
							<Field label='Repository'>
								{providerId === '' ? (
									<Input
										mono
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
								<Field label='Branch'>
									{branches.isSuccess ? (
										<Combo
											value={branch}
											placeholder='Search branches'
											empty='No branches'
											options={branchOptions}
											onChange={setBranch}
										/>
									) : (
										<Input mono value={branch} onChange={event => setBranch(event.target.value)} />
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
										hint={
											credentialKind === savedCredentialKind
												? 'One is saved; typing replaces it.'
												: undefined
										}
									>
										{credentialKind === 'token' ? (
											<Input
												type='password'
												autoComplete='new-password'
												value={credentialSecret}
												onChange={event => setCredentialSecret(event.target.value)}
											/>
										) : (
											<Textarea
												mono
												autoComplete='off'
												rows={5}
												value={credentialSecret}
												onChange={event => setCredentialSecret(event.target.value)}
											/>
										)}
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
							<Input mono value={image} onChange={event => setImage(event.target.value)} />
						</Field>
					) : null}
					{editable && showing === 'image' ? (
						<div className='grid gap-x-6 md:grid-cols-2'>
							<Field label='Registry URL'>
								<Input
									mono
									value={registryUrl}
									placeholder='Docker Hub'
									onChange={event => setRegistryUrl(event.target.value)}
								/>
							</Field>
							<Field label='Username' hint='Leave empty for a public image.'>
								<Input
									mono
									value={registryUsername}
									autoComplete='off'
									onChange={event => setRegistryUsername(event.target.value)}
								/>
							</Field>
							<Field
								label='Password'
								hint={service.registry_username ? 'One is saved; typing replaces it.' : undefined}
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
					<Textarea rows={10} value={fragment} onChange={event => setFragment(event.target.value)} mono />
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
	const [outputDir, setOutputDir] = useState(service.output_dir)

	const save = useMutation({
		mutationFn: () =>
			api.updateService(service.id, {
				build_type: buildType,
				build_path: buildPath,
				dockerfile,
				build_target: buildTarget,
				output_dir: outputDir,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['service', service.id] })
		},
	})

	return (
		<FormSection
			title='Build'
			icon={IconHammer}
			hint={
				buildType === 'static'
					? 'Runs the build script from package.json in the root directory, if there is one, then serves only the output directory with Nginx on port 80; unknown paths fall back to index.html.'
					: 'Applied on the next deploy.'
			}
			onSave={() => save.mutate()}
			actions={
				<SaveButton
					mutation={save}
					dirty={
						buildType !== service.build_type ||
						buildPath !== service.build_path ||
						dockerfile !== service.dockerfile ||
						buildTarget !== service.build_target ||
						outputDir !== service.output_dir
					}
				/>
			}
		>
			<ErrorText error={save.error} />
			<div className='mb-4'>
				<Segmented label='Build type' value={buildType} onChange={setBuildType} options={buildTypeOptions} />
			</div>
			<Field
				label={buildType === 'static' ? 'Root directory' : 'Context path'}
				hint={buildType === 'static' ? 'Where package.json is; the build runs here.' : undefined}
			>
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
						<Input value={buildTarget} onChange={event => setBuildTarget(event.target.value)} mono />
					</Field>
				</div>
			) : (
				<Field
					label='Output directory'
					hint='Relative to the root directory. Empty serves the first of dist/client, dist, build, out, .output/public, public holding an index.html.'
				>
					<Input value={outputDir} onChange={event => setOutputDir(event.target.value)} mono />
				</Field>
			)}
		</FormSection>
	)
}
