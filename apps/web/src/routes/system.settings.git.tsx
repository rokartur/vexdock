import { useMemo, useState } from 'react'
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
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import {
	Button,
	Confirm,
	ErrorText,
	Field,
	FormSection,
	IconButton,
	Input,
	Refresh,
	Section,
	Segmented,
	Status,
} from '../components/primitives'
import { api, type GitProvider, type GitProviderType } from '../lib/api'
import { since } from '../lib/format'

export const Route = createFileRoute('/system/settings/git')({
	// A host that refuses the handshake sends the owner back here, and a redirect
	// has no other way to say what went wrong.
	validateSearch: (search: Record<string, unknown>) => ({
		error: typeof search.error === 'string' ? search.error : undefined,
	}),
	component: GitProviders,
})

/** The four hosts a connection can be made to, in the order dokploy lists them. */
const kinds = [
	{ value: 'github', label: 'GitHub', icon: IconBrandGithub },
	{ value: 'gitlab', label: 'GitLab', icon: IconBrandGitlab },
	{ value: 'bitbucket', label: 'Bitbucket', icon: IconBrandBitbucket },
	{ value: 'gitea', label: 'Gitea', icon: IconCup },
] as const satisfies readonly { value: GitProviderType; label: string; icon: unknown }[]

const iconFor = (type: GitProviderType) => kinds.find(kind => kind.value === type)?.icon ?? IconPlug

/** The origin the connection talks to, which is the only field all four share. */
const hostOf = (provider: GitProvider) =>
	provider.github?.github_url ?? provider.gitlab?.gitlab_url ?? provider.gitea?.gitea_url ?? 'https://bitbucket.org'

/** Where the owner picks which repositories an installed GitHub App may reach. */
const installationURL = (provider: GitProvider) =>
	`${hostOf(provider)}/apps/${provider.github?.github_app_name}/installations/new?state=${provider.git_provider_id}`

function providerColumns(edit: (provider: GitProvider) => void, remove: (id: string) => void): Columns<GitProvider> {
	const cell = columnsFor<GitProvider>()
	return [
		cell.accessor(provider => provider.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => {
				const Icon = iconFor(row.original.provider_type)
				return (
					<span className='inline-flex items-center gap-2 font-medium'>
						<Icon className='size-4 text-muted-foreground' />
						{row.original.name}
					</span>
				)
			},
		}),
		cell.accessor(provider => provider.provider_type, { id: 'type', header: 'Provider' }),
		cell.accessor(provider => hostOf(provider), { id: 'host', header: 'Host', meta: { mono: true } }),
		cell.accessor(provider => (provider.connected ? 'connected' : 'pending'), {
			id: 'state',
			header: 'State',
			cell: ({ row }) => <Status value={row.original.connected ? 'connected' : 'pending'} />,
		}),
		cell.accessor(provider => provider.created_at, {
			id: 'added',
			header: 'Added',
			cell: ({ row }) => <span className='text-muted-foreground'>{since(row.original.created_at)}</span>,
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<div className='flex items-center justify-end gap-1'>
					{row.original.github ? (
						<Button
							variant='ghost'
							render={
								<a href={installationURL(row.original)}>
									{row.original.github.github_installation_id ? 'Repositories' : 'Finish install'}
								</a>
							}
						>
							<IconSettings />
							{row.original.github.github_installation_id ? 'Repositories' : 'Finish install'}
						</Button>
					) : (
						<IconButton icon={IconPencil} label='Edit' onClick={() => edit(row.original)} />
					)}
					<Confirm
						title={`Remove ${row.original.name}?`}
						description='Services cloning through it have to be pointed somewhere else first.'
						action='Remove'
						onConfirm={() => remove(row.original.git_provider_id)}
					>
						<IconButton icon={IconTrash} label='Remove' />
					</Confirm>
				</div>
			),
		}),
	]
}

/** Every field any of the four asks for, so one form covers all of them. */
const emptyForm = {
	id: '' as string,
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
}

type Form = typeof emptyForm

/**
 * GitHub creates the App from a manifest posted by the browser, not by the
 * manager: it is the owner's session that is allowed to create it. So the
 * manifest goes into a throwaway form and is submitted, which leaves the panel
 * for GitHub and comes back through the callback.
 */
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

/**
 * The host to authorise at is built by the manager from the origin the owner
 * typed, so the scheme check is all that is left to assert: a mangled response
 * must not turn into a javascript: navigation.
 */
function leaveFor(url: string) {
	const target = new URL(url)
	if (target.protocol !== 'https:' && target.protocol !== 'http:') {
		throw new Error(`refusing to open ${url}`)
	}
	window.location.assign(target.href)
}

/**
 * Saving is a different request per host, and three of the four end by leaving
 * the panel: GitHub to create the App, GitLab and Gitea to authorise it.
 * Bitbucket is the only one finished by the time the request answers.
 */
async function saveProvider(form: Form) {
	const id = form.id || undefined
	if (form.kind === 'bitbucket') {
		await api.saveBitbucketProvider(id, {
			name: form.name,
			bitbucket_username: form.username,
			app_password: form.appPassword,
			bitbucket_email: form.email,
			api_token: form.apiToken,
			bitbucket_workspace_name: form.workspace,
		})
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
	leaveFor(authorize_url)
	return false
}

/** What each host needs registered, and where the owner registers it. */
const hints: Record<GitProviderType, string> = {
	github: 'GitHub creates the App from this form, then asks which repositories it may read. The panel has to be reachable over https.',
	gitlab: 'Create an application under User settings, Applications with the api and read_repository scopes, then paste its id and secret.',
	bitbucket:
		'Either a username and app password, or an email and API token. The workspace is only needed to list a team’s repositories.',
	gitea: 'Create an OAuth2 application under Settings, Applications, then paste its client id and secret.',
}

function saveLabel(pending: boolean, editing: boolean) {
	if (pending) return 'Connecting…'
	return editing ? 'Save' : 'Connect'
}

function GitProviders() {
	const queryClient = useQueryClient()
	const { error: redirectError } = Route.useSearch()
	const providers = useQuery({ queryKey: ['git-providers'], queryFn: api.gitProviders })
	const [form, setForm] = useState(emptyForm)
	const set = <TKey extends keyof Form>(key: TKey, value: Form[TKey]) =>
		setForm(current => ({ ...current, [key]: value }))

	const save = useMutation({
		mutationFn: async () => {
			// Editing renames too: the per-host save only re-registers credentials.
			if (form.id) await api.renameGitProvider(form.id, form.name)
			return saveProvider(form)
		},
		onSuccess: async finished => {
			// A flow that leaves for the host is not done, so the form stays put
			// until the browser navigates away.
			if (!finished) return
			setForm(emptyForm)
			await queryClient.invalidateQueries({ queryKey: ['git-providers'] })
		},
	})

	const remove = useMutation({
		mutationFn: (id: string) => api.deleteGitProvider(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['git-providers'] }),
	})

	const { mutate: removeProvider } = remove
	const columns = useMemo(
		() =>
			providerColumns(provider => {
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
				})
			}, removeProvider),
		[removeProvider],
	)

	return (
		<div className='max-w-3xl'>
			<Section
				title='Git connections'
				description='connect once, then pick a repository instead of pasting a URL'
				actions={<Refresh onClick={() => providers.refetch()} busy={providers.isFetching} />}
			>
				<ErrorText error={remove.error ?? (redirectError ? new Error(redirectError) : null)} />
				<DataTable
					data={providers.data ?? []}
					columns={columns}
					loading={providers.isLoading}
					getRowId={provider => provider.git_provider_id}
					empty='No connections. A service can still clone from a git URL.'
				/>
			</Section>

			<FormSection
				title={form.id ? `Edit ${form.name}` : 'Connect a provider'}
				icon={iconFor(form.kind)}
				hint={hints[form.kind]}
				actions={
					<>
						{form.id ? <Button onClick={() => setForm(emptyForm)}>Cancel</Button> : null}
						<Button type='submit' variant='primary' disabled={save.isPending}>
							<IconPlug />
							{saveLabel(save.isPending, form.id !== '')}
						</Button>
					</>
				}
				onSave={() => save.mutate()}
			>
				<ErrorText error={save.error} />
				<div className='mb-4'>
					<Segmented
						value={form.kind}
						options={kinds}
						// Switching host mid-edit would save the wrong shape, so it drops
						// whatever was typed.
						onChange={kind => setForm({ ...emptyForm, kind })}
					/>
				</div>
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
								placeholder={`https://${form.kind}.com`}
								value={form.host}
								onChange={event => set('host', event.target.value)}
							/>
						</Field>
					)}
					{form.kind === 'github' ? (
						<Field label='Organization' hint='Empty installs the App on your own account.'>
							<Input
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
									required
									value={form.clientId}
									onChange={event => set('clientId', event.target.value)}
								/>
							</Field>
							<Field label='Secret'>
								<Input
									required
									type='password'
									value={form.clientSecret}
									onChange={event => set('clientSecret', event.target.value)}
								/>
							</Field>
							<Field label={form.kind === 'gitlab' ? 'Group' : 'Organization'}>
								<Input
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
								<Input value={form.username} onChange={event => set('username', event.target.value)} />
							</Field>
							<Field label='App password'>
								<Input
									type='password'
									value={form.appPassword}
									onChange={event => set('appPassword', event.target.value)}
								/>
							</Field>
							<Field label='Email'>
								<Input
									type='email'
									value={form.email}
									onChange={event => set('email', event.target.value)}
								/>
							</Field>
							<Field label='API token'>
								<Input
									type='password'
									value={form.apiToken}
									onChange={event => set('apiToken', event.target.value)}
								/>
							</Field>
							<Field label='Workspace'>
								<Input
									placeholder='acme'
									value={form.workspace}
									onChange={event => set('workspace', event.target.value)}
								/>
							</Field>
						</>
					) : null}
				</div>
			</FormSection>
		</div>
	)
}
