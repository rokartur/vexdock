import { useMemo, useState } from 'react'
import { IconBrandGithub, IconBrandGitlab, IconCup, IconPlug, IconSettings, IconTrash } from '@tabler/icons-react'
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
	Select,
} from '../components/primitives'
import { api, type GitAccount, type ServiceProvider } from '../lib/api'
import { since } from '../lib/format'

export const Route = createFileRoute('/system/settings/git')({
	// GitHub sends the owner back here when connecting an app goes wrong, and a
	// redirect has no other way to say so.
	validateSearch: (search: Record<string, unknown>) => ({
		error: typeof search.error === 'string' ? search.error : undefined,
	}),
	component: GitAccounts,
})

/** Where the owner picks which repositories an installed app may reach. */
const installationURL = (account: GitAccount) =>
	`https://github.com/apps/${account.app_slug}/installations/new?state=${account.id}`

/** The providers with a repository list behind a token. A plain git URL has no API. */
const providers = [
	{ value: 'github', label: 'GitHub', icon: IconBrandGithub },
	{ value: 'gitlab', label: 'GitLab', icon: IconBrandGitlab },
	{ value: 'gitea', label: 'Gitea', icon: IconCup },
] as const satisfies readonly { value: ServiceProvider; label: string; icon: unknown }[]

function accountTableColumns(remove: (id: string) => void): Columns<GitAccount> {
	const cell = columnsFor<GitAccount>()
	return [
		cell.accessor(account => account.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => {
				const Icon = providers.find(provider => provider.value === row.original.provider)?.icon ?? IconPlug
				return (
					<span className='inline-flex items-center gap-2 font-medium'>
						<Icon className='size-4 text-muted-foreground' />
						{row.original.name}
					</span>
				)
			},
		}),
		cell.accessor(account => (account.app_id ? 'github app' : account.provider), {
			id: 'provider',
			header: 'Provider',
		}),
		cell.accessor(account => account.host || 'hosted', { id: 'host', header: 'Host', meta: { mono: true } }),
		cell.accessor(account => account.created_at, {
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
					{row.original.app_id ? (
						<Button variant='ghost' render={<a href={installationURL(row.original)} />}>
							<IconSettings />
							{row.original.installation_id ? 'Repositories' : 'Finish install'}
						</Button>
					) : null}
					<Confirm
						title={`Remove ${row.original.name}?`}
						description='Services using this account keep their repository but can no longer pull with it.'
						action='Remove'
						onConfirm={() => remove(row.original.id)}
					>
						<IconButton icon={IconTrash} label='Remove' />
					</Confirm>
				</div>
			),
		}),
	]
}

const emptyForm = { provider: 'github' as ServiceProvider, name: '', host: '', token: '' }

/**
 * GitHub creates an app from a manifest posted by the browser, not by the
 * manager: it is the owner's session that is allowed to create it. So the
 * manifest is handed to a throwaway form and submitted, which leaves the panel
 * for GitHub and comes back through the callback.
 */
function postManifest(postURL: string, manifest: string) {
	const form = document.createElement('form')
	form.method = 'post'
	form.action = postURL
	const field = document.createElement('input')
	field.type = 'hidden'
	field.name = 'manifest'
	field.value = manifest
	form.append(field)
	document.body.append(form)
	form.submit()
}

function GitAccounts() {
	const queryClient = useQueryClient()
	const { error: redirectError } = Route.useSearch()
	const accounts = useQuery({ queryKey: ['git-accounts'], queryFn: api.gitAccounts })
	const [form, setForm] = useState(emptyForm)
	const [app, setApp] = useState({ name: 'vexdock', organization: '' })

	const connectApp = useMutation({
		mutationFn: () => api.gitAppManifest(app),
		onSuccess: ({ post_url, manifest }) => postManifest(post_url, manifest),
	})

	const create = useMutation({
		mutationFn: () => api.createGitAccount(form),
		onSuccess: async () => {
			setForm(emptyForm)
			await queryClient.invalidateQueries({ queryKey: ['git-accounts'] })
		},
	})

	const remove = useMutation({
		mutationFn: (id: string) => api.deleteGitAccount(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['git-accounts'] }),
	})

	const { mutate: removeAccount } = remove
	const columns = useMemo(() => accountTableColumns(removeAccount), [removeAccount])

	return (
		<div className='max-w-3xl'>
			<Section
				title='Git accounts'
				description='connect once, then pick a repository instead of pasting a URL'
				actions={<Refresh onClick={() => accounts.refetch()} busy={accounts.isFetching} />}
			>
				<ErrorText error={remove.error ?? (redirectError ? new Error(redirectError) : null)} />
				<DataTable
					data={accounts.data ?? []}
					columns={columns}
					loading={accounts.isLoading}
					getRowId={account => account.id}
					empty='No accounts connected. A service can still clone from a git URL.'
				/>
			</Section>

			<FormSection
				title='Connect a GitHub App'
				description='GitHub creates the app, you pick which repositories it may reach.'
				icon={IconBrandGithub}
				hint='Leave the organization empty to install on your own account. The panel must be reachable over https.'
				actions={
					<Button type='submit' variant='primary' disabled={connectApp.isPending}>
						<IconBrandGithub />
						{connectApp.isPending ? 'Opening GitHub…' : 'Create on GitHub'}
					</Button>
				}
				onSave={() => connectApp.mutate()}
			>
				<ErrorText error={connectApp.error} />
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='App name' hint='Has to be free on GitHub.'>
						<Input
							required
							value={app.name}
							onChange={event => setApp({ ...app, name: event.target.value })}
						/>
					</Field>
					<Field label='Organization'>
						<Input
							placeholder='acme'
							value={app.organization}
							onChange={event => setApp({ ...app, organization: event.target.value })}
						/>
					</Field>
				</div>
			</FormSection>

			<FormSection
				title='Connect an account'
				description='A personal access token with read access to the repositories.'
				icon={IconPlug}
				hint={
					form.provider === 'gitea'
						? 'Gitea needs the host of the instance.'
						: 'Host is only for a self-hosted instance.'
				}
				actions={
					<Button type='submit' variant='primary' disabled={create.isPending}>
						<IconPlug />
						{create.isPending ? 'Verifying…' : 'Connect'}
					</Button>
				}
				onSave={() => create.mutate()}
			>
				<ErrorText error={create.error} />
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Provider'>
						<Select
							value={form.provider}
							options={providers}
							onChange={provider => setForm({ ...form, provider })}
						/>
					</Field>
					<Field label='Name'>
						<Input
							required
							placeholder='acme'
							value={form.name}
							onChange={event => setForm({ ...form, name: event.target.value })}
						/>
					</Field>
					<Field label='Host'>
						<Input
							required={form.provider === 'gitea'}
							placeholder='https://git.example.com'
							value={form.host}
							onChange={event => setForm({ ...form, host: event.target.value })}
						/>
					</Field>
					<Field label='Access token'>
						<Input
							required
							type='password'
							value={form.token}
							onChange={event => setForm({ ...form, token: event.target.value })}
						/>
					</Field>
				</div>
			</FormSection>
		</div>
	)
}
