import { useState } from 'react'
import {
	IconBrandBitbucket,
	IconBrandGithub,
	IconBrandGitlab,
	IconCup,
	IconPencil,
	IconPlug,
	IconSettings,
	IconTrash,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { CopyButton } from '@/components/ui/copy-button'
import { IntegrationList, IntegrationRow } from '../components/integration-list'
import {
	Button,
	Confirm,
	EmptyState,
	ErrorText,
	ListPlaceholder,
	Field,
	FormDialog,
	IconButton,
	Input,
	Refresh,
	RelativeTime,
	Section,
	Segmented,
	StatStrip,
	Status,
} from '../components/primitives'
import { api, type GitProvider, type GitProviderType } from '../lib/api'
import { gitProvidersQuery, preload } from '../lib/queries'

export const Route = createFileRoute('/system/settings/git')({
	// A host that refuses the handshake sends the owner back here, and a redirect
	// has no other way to say what went wrong.
	validateSearch: (search: Record<string, unknown>) => ({
		error: typeof search.error === 'string' ? search.error : undefined,
	}),
	loader: ({ context: { queryClient } }) => preload(queryClient, gitProvidersQuery),
	component: GitProviders,
})

/** The four hosts a connection can be made to, in the order dokploy lists them. */
const kinds = [
	{ value: 'github', label: 'GitHub', icon: IconBrandGithub },
	{ value: 'gitlab', label: 'GitLab', icon: IconBrandGitlab },
	{ value: 'bitbucket', label: 'Bitbucket', icon: IconBrandBitbucket },
	{ value: 'gitea', label: 'Gitea', icon: IconCup },
] as const satisfies readonly { value: GitProviderType; label: string; icon: unknown }[]

/** The origin the connection talks to, which is the only field all four share. */
const hostOf = (provider: GitProvider) =>
	provider.github?.github_url ?? provider.gitlab?.gitlab_url ?? provider.gitea?.gitea_url ?? 'https://bitbucket.org'

function ProviderRow({
	provider,
	edit,
	remove,
	removing,
}: {
	provider: GitProvider
	edit: (provider: GitProvider) => void
	remove: (id: string) => void
	/** The connection a remove is in flight for, if any. */
	removing: string | undefined
}) {
	const kind = kinds.find(each => each.value === provider.provider_type)
	return (
		<IntegrationRow
			icon={kind?.icon ?? IconPlug}
			name={provider.name}
			kind={kind?.label}
			description={
				<>
					<span className='font-mono'>{hostOf(provider)}</span>, added{' '}
					<RelativeTime at={provider.created_at} />
				</>
			}
		>
			<Status value={provider.connected ? 'connected' : 'pending'} />
			{provider.github ? (
				provider.install_url && (
					// oxlint-disable-next-line jsx-a11y/control-has-associated-label -- Button renders its children into the link
					<Button variant='ghost' render={<a href={provider.install_url} />}>
						<IconSettings size={16} stroke={1.75} />
						{provider.github.github_installation_id ? 'Choose repositories' : 'Finish install'}
					</Button>
				)
			) : (
				<IconButton icon={IconPencil} label={`Edit ${provider.name}`} onClick={() => edit(provider)} />
			)}
			<Confirm
				title={`Remove ${provider.name}?`}
				description='Services cloning through it have to be pointed somewhere else first.'
				action='Remove connection'
				onConfirm={() => remove(provider.git_provider_id)}
			>
				<IconButton
					icon={IconTrash}
					label={`Remove ${provider.name}`}
					loading={removing === provider.git_provider_id}
					disabled={removing !== undefined}
				/>
			</Confirm>
		</IntegrationRow>
	)
}

/** Every field any of the four asks for, so one form covers all of them. */
const emptyForm = {
	id: '',
	kind: 'github' as GitProviderType,
	name: '',
	host: '',
	organization: '',
	clientId: '',
	clientSecret: '',
	username: '',
	appPassword: '',
	email: '',
	apiToken: '',
	workspace: '',
	webhookUrl: '',
}

type Form = typeof emptyForm

/** GitHub creates the App from the owner's own session, so a throwaway form posts the manifest and the callback
 * brings it back. */
function postManifest(url: string, manifest: unknown) {
	const form = document.createElement('form')
	form.method = 'post'
	form.action = url
	const field = document.createElement('input')
	field.type = 'hidden'
	field.name = 'manifest'
	field.value = JSON.stringify(manifest)
	form.append(field)
	document.body.append(form)
	form.submit()
}

/** The manager builds the host from the origin the owner typed, so only the scheme is left to check. */
function leaveFor(url: string) {
	const target = new URL(url)
	if (target.protocol !== 'https:' && target.protocol !== 'http:') {
		throw new Error(`The host sent back ${url}, which is not an http or https address. Check the Host field.`)
	}
	window.location.assign(target.href)
}

/** GitHub, GitLab and Gitea end by leaving the panel. Bitbucket is the only one done when the request answers. */
async function saveProvider(form: Form) {
	const id = form.id || undefined
	// The per-host save ignores the name of an existing connection, so an edit renames after it, once the credentials took.
	const rename = async () => {
		if (id) await api.renameGitProvider(id, form.name)
	}
	if (form.kind === 'bitbucket') {
		await api.saveBitbucketProvider(id, {
			name: form.name,
			bitbucket_username: form.username,
			app_password: form.appPassword,
			bitbucket_email: form.email,
			api_token: form.apiToken,
			bitbucket_workspace_name: form.workspace,
		})
		await rename()
		return true
	}
	if (form.kind === 'github') {
		const { manifest, manifest_url } = await api.createGitHubProvider({
			name: form.name,
			github_url: form.host,
			organization: form.organization,
		})
		postManifest(manifest_url, manifest)
		return false
	}
	const { authorize_url } =
		form.kind === 'gitlab'
			? await api.saveGitLabProvider(id, {
					name: form.name,
					gitlab_url: form.host,
					application_id: form.clientId,
					secret: form.clientSecret,
					group_name: form.organization,
				})
			: await api.saveGiteaProvider(id, {
					name: form.name,
					gitea_url: form.host,
					client_id: form.clientId,
					client_secret: form.clientSecret,
					organization_name: form.organization,
				})
	await rename()
	leaveFor(authorize_url)
	return false
}

/**
 * GitLab and Gitea refuse an authorization whose redirect URI they were not told about, so the hint spells out the
 * one this panel sends, built from the address the browser is on because that is where the provider comes back to.
 */
function hintFor(kind: GitProviderType, origin: string) {
	switch (kind) {
		case 'github': {
			return 'GitHub creates the App from this form, then asks which repositories it may read. The panel has to be reachable over HTTPS.'
		}
		case 'gitlab': {
			return `Create an application under User settings, Applications with the api and read_repository scopes and the redirect URI ${origin}/api/providers/gitlab/callback, then paste its id and secret.`
		}
		case 'gitea': {
			return `Create an OAuth2 application under Settings, Applications with the redirect URI ${origin}/api/providers/gitea/callback, then paste its client id and secret.`
		}
		default: {
			return 'Either a username and app password, or an email and API token. The workspace is only needed to list a team’s repositories.'
		}
	}
}

function GitProviders() {
	const queryClient = useQueryClient()
	const { error: redirectError } = Route.useSearch()
	const navigate = Route.useNavigate()
	// A later change that lands answers the failed callback, so its message leaves the URL.
	const dropRedirectError = () => navigate({ search: { error: undefined }, replace: true })
	const providers = useQuery(gitProvidersQuery)
	const { origin } = window.location
	const [open, setOpen] = useState(false)
	const [form, setForm] = useState(emptyForm)
	const [copyFailed, setCopyFailed] = useState(false)
	const set = <TKey extends keyof Form>(key: TKey, value: Form[TKey]) =>
		setForm(current => ({ ...current, [key]: value }))

	const save = useMutation({
		mutationFn: () => saveProvider(form),
		onSuccess: async finished => {
			// A flow that leaves for the host is not done, so the form stays put
			// until the browser navigates away.
			if (!finished) return
			setForm(emptyForm)
			setOpen(false)
			await dropRedirectError()
			await queryClient.invalidateQueries({ queryKey: ['git-providers'] })
		},
	})

	const remove = useMutation({
		mutationFn: api.deleteGitProvider,
		onSuccess: async () => {
			await dropRedirectError()
			await queryClient.invalidateQueries({ queryKey: ['git-providers'] })
		},
	})

	const { mutate: removeProvider } = remove
	const edit = (provider: GitProvider) => {
		setForm({
			...emptyForm,
			id: provider.git_provider_id,
			kind: provider.provider_type,
			name: provider.name,
			host: hostOf(provider),
			organization: provider.gitlab?.group_name ?? provider.gitea?.organization_name ?? '',
			clientId: provider.gitlab?.application_id ?? provider.gitea?.client_id ?? '',
			username: provider.bitbucket?.bitbucket_username ?? '',
			email: provider.bitbucket?.bitbucket_email ?? '',
			workspace: provider.bitbucket?.bitbucket_workspace_name ?? '',
			webhookUrl: provider.webhook_url ?? '',
		})
		setOpen(true)
	}

	const listed = providers.data ?? []
	const editing = listed.find(provider => provider.git_provider_id === form.id)
	const connected = listed.filter(provider => provider.connected).length
	// A GitHub App that was created but never pointed at a repository can clone nothing.
	const unfinished = listed.filter(provider => provider.github && !provider.github.github_installation_id).length
	// The list arrives oldest first, so the newest connection is the last one.
	const newest = listed.at(-1)

	return (
		<div className='max-w-3xl'>
			{newest ? (
				<StatStrip
					className='mb-4'
					items={[
						{ label: 'Connected', value: connected },
						{ label: 'Pending', value: listed.length - connected },
						{ label: 'Install unfinished', value: unfinished },
						{ label: 'Newest', value: <RelativeTime at={newest.created_at} /> },
					]}
				/>
			) : null}
			<Section
				title='Git connections'
				total={providers.data?.length}
				actions={
					<>
						<Refresh onClick={() => providers.refetch()} />
						<Button variant='primary' size='sm' onClick={() => setOpen(true)}>
							<IconPlug size={16} stroke={1.75} />
							Connect a provider
						</Button>
					</>
				}
			>
				<ErrorText error={remove.error ?? (redirectError ? new Error(redirectError) : null)} />
				<ErrorText error={providers.error} />
				{listed.length > 0 ? (
					<IntegrationList>
						{listed.map(provider => (
							<ProviderRow
								key={provider.git_provider_id}
								provider={provider}
								edit={edit}
								remove={removeProvider}
								removing={remove.isPending ? remove.variables : undefined}
							/>
						))}
					</IntegrationList>
				) : providers.error ? null : (
					<ListPlaceholder loading={providers.isLoading} label='Loading connections'>
						<EmptyState
							icon={IconPlug}
							title='No connections'
							description='Connect a provider to pick repositories from a list. A service can still clone from a git URL without one.'
						/>
					</ListPlaceholder>
				)}
			</Section>

			<FormDialog
				open={open}
				onOpenChange={next => {
					setOpen(next)
					if (next) return
					setForm(emptyForm)
					setCopyFailed(false)
				}}
				title={form.id ? `Edit ${editing?.name ?? 'connection'}` : 'Connect a provider'}
				description={hintFor(form.kind, origin)}
				action={form.id ? 'Save connection' : 'Connect provider'}
				icon={IconPlug}
				mutation={save}
				wide
				onSubmit={() => save.mutate()}
			>
				{/* An edit keeps its host: a switch would reset the form and save a new connection. */}
				{form.id ? null : (
					<div className='mb-4'>
						<Segmented
							label='Git host'
							value={form.kind}
							options={kinds}
							// Switching host before saving would send the wrong shape, so it drops whatever was typed.
							onChange={kind => setForm({ ...emptyForm, kind })}
						/>
					</div>
				)}
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Name'>
						<Input
							required
							placeholder='acme'
							value={form.name}
							onChange={event => set('name', event.target.value)}
						/>
					</Field>
					{form.kind === 'bitbucket' ? null : (
						<Field
							label='Host'
							hint={form.kind === 'github' ? 'A GitHub Enterprise origin.' : 'A self-hosted origin.'}
						>
							<Input
								mono
								placeholder={`https://${form.kind}.com`}
								value={form.host}
								onChange={event => set('host', event.target.value)}
							/>
						</Field>
					)}
					{form.kind === 'github' ? (
						<Field label='Organization' hint='Empty installs the App on your own account.'>
							<Input
								mono
								placeholder='acme'
								value={form.organization}
								onChange={event => set('organization', event.target.value)}
							/>
						</Field>
					) : null}
					{form.kind === 'gitlab' || form.kind === 'gitea' ? (
						<>
							<Field label={form.kind === 'gitlab' ? 'Application ID' : 'Client ID'}>
								<Input
									mono
									required
									value={form.clientId}
									onChange={event => set('clientId', event.target.value)}
								/>
							</Field>
							<Field
								label='Secret'
								hint={
									form.id
										? 'The stored secret is never sent back; paste it again, since saving reconnects.'
										: undefined
								}
							>
								<Input
									mono
									required
									type='password'
									autoComplete='new-password'
									value={form.clientSecret}
									onChange={event => set('clientSecret', event.target.value)}
								/>
							</Field>
							<Field label={form.kind === 'gitlab' ? 'Group' : 'Organization'}>
								<Input
									mono
									placeholder='acme'
									value={form.organization}
									onChange={event => set('organization', event.target.value)}
								/>
							</Field>
						</>
					) : null}
					{form.kind === 'bitbucket' ? (
						<>
							<Field label='Username'>
								<Input
									mono
									autoComplete='off'
									value={form.username}
									onChange={event => set('username', event.target.value)}
								/>
							</Field>
							<Field
								label='App password'
								hint={
									form.id
										? 'Stored secrets are never sent back. Saving replaces both, so paste the pair you sign in with again.'
										: undefined
								}
							>
								<Input
									mono
									type='password'
									autoComplete='new-password'
									value={form.appPassword}
									onChange={event => set('appPassword', event.target.value)}
								/>
							</Field>
							<Field label='Email'>
								<Input
									type='email'
									autoComplete='off'
									value={form.email}
									onChange={event => set('email', event.target.value)}
								/>
							</Field>
							<Field label='API token'>
								<Input
									mono
									type='password'
									autoComplete='new-password'
									value={form.apiToken}
									onChange={event => set('apiToken', event.target.value)}
								/>
							</Field>
							<Field label='Workspace'>
								<Input
									mono
									placeholder='acme'
									value={form.workspace}
									onChange={event => set('workspace', event.target.value)}
								/>
							</Field>
						</>
					) : null}
					{form.webhookUrl ? (
						<Field
							label='Push hook'
							hint='Add this URL as a push webhook on the host. Its token is what tells the deliveries apart from anyone else’s.'
						>
							<div className='flex items-center gap-1'>
								<Input readOnly mono value={form.webhookUrl} onFocus={event => event.target.select()} />
								<CopyButton
									value={form.webhookUrl}
									label='Copy the push hook URL'
									iconOnly
									variant='plain'
									onCopied={() => setCopyFailed(false)}
									onError={() => setCopyFailed(true)}
								/>
							</div>
							<ErrorText
								error={
									copyFailed ? 'Copying needs HTTPS. Select the address and copy it by hand.' : null
								}
								className='mt-2 mb-0'
							/>
						</Field>
					) : null}
				</div>
			</FormDialog>
		</div>
	)
}
