import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, ErrorText, Field, Refresh, Section, Select } from '../components/primitives'
import { api, type GitAccount, type ServiceProvider } from '../lib/api'
import { since } from '../lib/format'

export const Route = createFileRoute('/system/settings/git')({ component: GitAccounts })

/** The providers with a repository list behind a token. A plain git URL has no API. */
const providers = [
	{ value: 'github', label: 'GitHub' },
	{ value: 'gitlab', label: 'GitLab' },
	{ value: 'gitea', label: 'Gitea' },
] as const satisfies readonly { value: ServiceProvider; label: string }[]

function accountTableColumns(remove: (id: string) => void): Columns<GitAccount> {
	const cell = columnsFor<GitAccount>()
	return [
		cell.accessor(account => account.name, { id: 'name', header: 'Name' }),
		cell.accessor(account => account.provider, { id: 'provider', header: 'Provider' }),
		cell.accessor(account => account.host || 'hosted', { id: 'host', header: 'Host', meta: { mono: true } }),
		cell.accessor(account => account.created_at, {
			id: 'added',
			header: 'Added',
			cell: ({ row }) => since(row.original.created_at),
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Button variant='ghost' onClick={() => remove(row.original.id)}>
					remove
				</Button>
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
		<Section
			title='Git accounts'
			description='connect once, then pick a repository instead of pasting a URL'
			actions={<Refresh onClick={() => accounts.refetch()} busy={accounts.isFetching} />}
		>
			<DataTable
				data={accounts.data ?? []}
				columns={columns}
				loading={accounts.isLoading}
				getRowId={account => account.id}
				empty='No accounts connected. A service can still clone from a git URL.'
			/>

			<form
				className='mt-3 grid max-w-4xl gap-x-6 md:grid-cols-4'
				onSubmit={event => {
					event.preventDefault()
					create.mutate()
				}}
			>
				<Field label='Provider'>
					<Select
						value={form.provider}
						options={providers}
						onChange={provider => setForm({ ...form, provider })}
					/>
				</Field>
				<Field label='Name'>
					<input
						required
						placeholder='acme'
						value={form.name}
						onChange={event => setForm({ ...form, name: event.target.value })}
					/>
				</Field>
				<Field label='Host' hint={form.provider === 'gitea' ? 'required' : 'only for a self-hosted instance'}>
					<input
						required={form.provider === 'gitea'}
						placeholder='https://git.example.com'
						value={form.host}
						onChange={event => setForm({ ...form, host: event.target.value })}
					/>
				</Field>
				<Field label='Access token' hint='needs read access to the repositories'>
					<input
						required
						type='password'
						value={form.token}
						onChange={event => setForm({ ...form, token: event.target.value })}
					/>
				</Field>
				<div className='md:col-span-4'>
					<ErrorText error={create.error ?? remove.error} />
					<Button type='submit' disabled={create.isPending}>
						{create.isPending ? 'Verifying…' : 'Connect account'}
					</Button>
				</div>
			</form>
		</Section>
	)
}
