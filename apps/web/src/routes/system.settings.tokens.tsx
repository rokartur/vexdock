import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, ErrorText, Field, Refresh, Section } from '../components/primitives'
import { api, type ApiToken } from '../lib/api'
import { since } from '../lib/format'

export const Route = createFileRoute('/system/settings/tokens')({ component: ApiTokens })

function tokenTableColumns(revoke: (id: string) => void): Columns<ApiToken> {
	const cell = columnsFor<ApiToken>()
	return [
		cell.accessor(token => token.name, { id: 'name', header: 'Name' }),
		cell.accessor(token => token.prefix, {
			id: 'prefix',
			header: 'Prefix',
			meta: { mono: true },
			cell: ({ row }) => `${row.original.prefix}…`,
		}),
		cell.accessor(token => token.last_used_at ?? '', {
			id: 'last-used',
			header: 'Last used',
			cell: ({ row }) => (row.original.last_used_at ? since(row.original.last_used_at) : 'never'),
		}),
		cell.accessor(token => token.created_at, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => since(row.original.created_at),
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Button variant='ghost' onClick={() => revoke(row.original.id)}>
					revoke
				</Button>
			),
		}),
	]
}

function ApiTokens() {
	const queryClient = useQueryClient()
	const tokens = useQuery({ queryKey: ['tokens'], queryFn: api.tokens })
	const [name, setName] = useState('')
	const [issued, setIssued] = useState('')

	const create = useMutation({
		mutationFn: () => api.createToken(name),
		onSuccess: async result => {
			setIssued(result.value)
			setName('')
			await queryClient.invalidateQueries({ queryKey: ['tokens'] })
		},
	})

	const remove = useMutation({
		mutationFn: (id: string) => api.deleteToken(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tokens'] }),
	})

	const { mutate: revokeToken } = remove
	const columns = useMemo(() => tokenTableColumns(revokeToken), [revokeToken])

	return (
		<Section
			title='API tokens'
			description='for CI and scripted deploys'
			actions={<Refresh onClick={() => tokens.refetch()} busy={tokens.isFetching} />}
		>
			<DataTable
				data={tokens.data ?? []}
				columns={columns}
				loading={tokens.isLoading}
				getRowId={token => token.id}
				empty='No tokens issued.'
			/>

			{issued ? (
				<p className='mt-3 max-w-2xl rounded-xl border border-border p-2 font-mono text-body break-all'>
					{issued}
					<span className='mt-1 block font-sans text-label text-amber-400'>
						Copy it now. It is not shown again.
					</span>
				</p>
			) : null}

			<form
				className='mt-3 flex items-end gap-2'
				onSubmit={event => {
					event.preventDefault()
					create.mutate()
				}}
			>
				<div className='w-64'>
					<Field label='Token name'>
						<input required value={name} onChange={event => setName(event.target.value)} placeholder='ci' />
					</Field>
				</div>
				<div className='pb-3'>
					<Button type='submit' disabled={create.isPending}>
						Create token
					</Button>
				</div>
			</form>
			<ErrorText error={create.error ?? remove.error} />
		</Section>
	)
}
