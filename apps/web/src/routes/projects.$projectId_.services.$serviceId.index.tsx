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
					<Fact label='Password' value={mask(data.password)} />
					<Fact label='URL' value={revealed ? data.url : data.url.replace(data.password, '•••')} />
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
	const [accountId, setAccountId] = useState(service.git_account_id)

	// An application arrives here as a bare name, so this page is where it gets
	// answered, and it can be answered again later. A database's provider is
	// fixed: its volume and credentials were rendered from the engine.
	const [provider, setProvider] = useState<ServiceProvider>(
		service.provider === 'unconfigured' ? 'github' : service.provider,
	)
	const editable = service.type === 'application'
	const showing = editable ? provider : service.provider
	const git = isGitProvider(showing)

	// A connected account replaces both the URL and the credential: it lists the
	// repositories it can clone, and its token is what clones them.
	const accounts = useQuery({ queryKey: ['git-accounts'], queryFn: api.gitAccounts, enabled: git })
	const accountOptions = [
		{ value: '', label: 'Repository URL' },
		...(accounts.data ?? [])
			.filter(account => account.provider === showing)
			.map(account => ({ value: account.id, label: account.name })),
	]
	const repositories = useQuery({
		queryKey: ['git-repositories', accountId],
		queryFn: () => api.gitRepositories(accountId),
		enabled: accountId !== '',
	})
	const listed = repositories.data ?? []
	const repositoryOptions = [
		...listed.map(repo => ({ value: repo.clone_url, label: repo.full_name })),
		// A repository the token stopped listing stays visible rather than
		// blanking a field the service still deploys from.
		...(repositoryUrl && !listed.some(repo => repo.clone_url === repositoryUrl)
			? [{ value: repositoryUrl, label: repositoryUrl }]
			: []),
	]

	// Branches come from the repository that is actually selected, so the field
	// offers what the remote has instead of accepting a name that fails at clone
	// time. A repository the account no longer lists has no name to ask about.
	const selectedRepository = listed.find(repo => repo.clone_url === repositoryUrl)
	const branches = useQuery({
		queryKey: ['git-branches', accountId, selectedRepository?.full_name],
		queryFn: () => api.gitBranches(accountId, selectedRepository?.full_name ?? ''),
		enabled: accountId !== '' && selectedRepository !== undefined,
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
							repository_url: repositoryUrl,
							branch: branch || 'main',
							build_path: buildPath,
							git_account_id: accountId,
							...(accountId === ''
								? {
										credential_kind: credentialKind,
										// An empty secret keeps the stored one; the manager only
										// re-encrypts what it is actually given.
										...(credentialSecret === '' ? {} : { credential_secret: credentialSecret }),
									}
								: {}),
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
							// An account belongs to one provider, so it cannot survive the switch.
							setAccountId('')
						}}
						options={providerOptions}
					/>
				</div>
			) : null}
			{git ? (
				<>
					{accountOptions.length > 1 || accountId !== '' ? (
						<Field label='Account'>
							<Select value={accountId} onChange={setAccountId} options={accountOptions} />
						</Field>
					) : null}
					<Field
						label='Repository'
						hint={accountId === '' ? undefined : (repositories.error?.message ?? undefined)}
					>
						{accountId === '' ? (
							<Input value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} />
						) : (
							<Combo
								value={repositoryUrl}
								disabled={repositories.isPending}
								placeholder={repositories.isPending ? 'Loading…' : 'Search repositories'}
								empty='No repositories'
								options={repositoryOptions}
								onChange={url => {
									setRepositoryUrl(url)
									const picked = listed.find(repo => repo.clone_url === url)
									if (picked) setBranch(picked.default_branch)
								}}
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
						{accountId === '' ? (
							<Field label='Credentials'>
								<Select
									value={credentialKind}
									onChange={setCredentialKind}
									options={credentialOptions}
								/>
							</Field>
						) : null}
						{accountId !== '' || credentialKind === 'none' ? null : (
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
