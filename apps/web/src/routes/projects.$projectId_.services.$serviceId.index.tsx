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
	IconPlug,
	IconRocket,
	IconTerminal2,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
	Button,
	Combo,
	ErrorText,
	Fact,
	Facts,
	Field,
	FormSection,
	Input,
	SaveButton,
	Segmented,
	Select,
	Status,
	Textarea,
} from '../components/primitives'
import { api, type CredentialKind, isGitProvider, type Service, type ServiceProvider } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { duration, since } from '../lib/format'
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

/**
 * Dokploy's General tab: how it deploys, then where the code comes from. A
 * database leads with its credentials, which is what it is opened for.
 */
function ServiceGeneral() {
	const { projectId, serviceId } = Route.useParams()
	const service = useService(serviceId)

	// The form is seeded from the service, so it waits for the first read
	// instead of mounting empty and overwriting what it never loaded.
	if (!service.data) return null
	return (
		<>
			{service.data.type === 'database' ? <DatabaseSections serviceId={serviceId} /> : null}
			<DeploySection projectId={projectId} service={service.data} />
			{/* Remounts on switch, so the fields follow the service the URL names. */}
			<SourceSection key={service.data.id} service={service.data} />
		</>
	)
}

/**
 * What happens on a push and what happened last. Auto deploy is the project's
 * setting, so it is read here and changed where every service can see it.
 */
function DeploySection({ projectId, service }: { projectId: string; service: Service }) {
	const environmentId = useEnvironmentId()
	const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) })
	const deployments = useQuery({
		queryKey: ['deployments', projectId, environmentId],
		queryFn: () => api.deployments(projectId, environmentId),
	})
	const latest = deployments.data?.find(
		deployment => !deployment.service_name || deployment.service_name === service.compose_service_name,
	)
	const params = { projectId, serviceId: service.id }

	return (
		<FormSection
			title='Deploy'
			description='Deploy, restart and stop are in the header. Their log opens under Deployments.'
			icon={IconRocket}
			hint='Auto deploy is the project’s setting.'
			actions={
				<Button render={<Link to='/projects/$projectId/services/$serviceId/terminal' params={params} />}>
					<IconTerminal2 />
					Open terminal
				</Button>
			}
		>
			<Facts>
				<Fact
					label='Last deploy'
					value={
						latest ? (
							<span className='inline-flex items-center gap-2'>
								<Link
									to='/projects/$projectId/services/$serviceId/deployments'
									params={params}
									search={{ deployment: latest.id }}
									className='underline-offset-4 hover:underline'
								>
									#{latest.number}
								</Link>
								<Status value={latest.status} />
								<span>{since(latest.created_at)}</span>
								<span>{duration(latest.started_at, latest.finished_at)}</span>
							</span>
						) : (
							'never'
						)
					}
				/>
				<Fact
					label='Auto deploy on push'
					value={
						<span className='inline-flex items-center gap-2'>
							{project.data?.auto_deploy ? 'on' : 'off'}
							<Link
								to='/projects/$projectId/settings'
								params={{ projectId }}
								className='font-sans underline-offset-4 hover:underline'
							>
								project settings
							</Link>
						</span>
					}
				/>
				<Fact label='Webhook' value={project.data?.webhook_url ?? '-'} />
			</Facts>
		</FormSection>
	)
}

/**
 * The credentials to reach a database, and the image it runs. The credentials
 * are read back out of the service's own environment and the image off the
 * service itself, so both are what the container will actually start with
 * rather than what the catalogue currently defaults to.
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
	const [buildPath, setBuildPath] = useState(service.build_path)
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
							build_path: buildPath,
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
				...(showing === 'raw' ? { compose_fragment: fragment } : {}),
			}),
		onSuccess: () => {
			setCredentialSecret('')
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
			actions={<SaveButton pending={save.isPending} />}
		>
			<ErrorText error={save.error} />
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
							<Input value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} />
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
						<Field label='Build path'>
							<Input value={buildPath} onChange={event => setBuildPath(event.target.value)} />
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
					hint={service.type === 'database' ? 'Changing the tag is how a database moves version.' : undefined}
				>
					<Input value={image} onChange={event => setImage(event.target.value)} />
				</Field>
			) : null}
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
