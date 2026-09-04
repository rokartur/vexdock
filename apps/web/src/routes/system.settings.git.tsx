import { useMemo, useState } from 'react'
import { IconBrandGithub, IconBrandGitlab, IconCup, IconPlug, IconTrash } from '@tabler/icons-react'
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

export const Route = createFileRoute('/system/settings/git')({ component: GitAccounts })

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
		cell.accessor(account => account.provider, { id: 'provider', header: 'Provider' }),
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
				<Confirm
					title={`Remove ${row.original.name}?`}
					description='Services using this account keep their repository but can no longer pull with it.'
					action='Remove'
					onConfirm={() => remove(row.original.id)}
				>
					<IconButton icon={IconTrash} label='Remove' />
				</Confirm>
			),
		}),
	]
}

const emptyForm = { provider: 'github' as ServiceProvider, name: '', host: '', token: '' }

function GitAccounts() {
	const queryClient = useQueryClient()
	const accounts = useQuery({ queryKey: ['git-accounts'], queryFn: api.gitAccounts })
	const [form, setForm] = useState(emptyForm)

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
				<ErrorText error={remove.error} />
				<DataTable
					data={accounts.data ?? []}
					columns={columns}
					loading={accounts.isLoading}
					getRowId={account => account.id}
					empty='No accounts connected. A service can still clone from a git URL.'
				/>
			</Section>

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
