import { useMemo, useState } from 'react'
import { IconAlertTriangle, IconKey, IconPlus, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
} from '../components/primitives'
import { api, type ApiToken } from '../lib/api'
import { since } from '../lib/format'

export const Route = createFileRoute('/system/settings/tokens')({ component: ApiTokens })

function tokenTableColumns(revoke: (id: string) => void): Columns<ApiToken> {
	const cell = columnsFor<ApiToken>()
	return [
		cell.accessor(token => token.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2 font-medium'>
					<IconKey className='size-4 text-muted-foreground' />
					{row.original.name}
				</span>
			),
		}),
		cell.accessor(token => token.prefix, {
			id: 'prefix',
			header: 'Prefix',
			meta: { mono: true },
			cell: ({ row }) => `${row.original.prefix}…`,
		}),
		cell.accessor(token => token.last_used_at ?? '', {
			id: 'last-used',
			header: 'Last used',
			cell: ({ row }) => (
				<span className='text-muted-foreground'>
					{row.original.last_used_at ? since(row.original.last_used_at) : 'never'}
				</span>
			),
		}),
		cell.accessor(token => token.created_at, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => <span className='text-muted-foreground'>{since(row.original.created_at)}</span>,
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Confirm
					title={`Revoke ${row.original.name}?`}
					description='Anything still using this token is locked out immediately.'
					action='Revoke'
					onConfirm={() => revoke(row.original.id)}
				>
					<IconButton icon={IconTrash} label='Revoke' />
				</Confirm>
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
		<div className='max-w-3xl'>
			<Section
				title='API tokens'
				description='for CI and scripted deploys'
				actions={<Refresh onClick={() => tokens.refetch()} busy={tokens.isFetching} />}
			>
				<ErrorText error={remove.error} />
				<DataTable
					data={tokens.data ?? []}
					columns={columns}
					loading={tokens.isLoading}
					getRowId={token => token.id}
					empty='No tokens issued'
				/>
			</Section>

			{issued ? (
				<Alert className='mb-4'>
					<IconAlertTriangle className='text-amber-400' />
					<AlertTitle>Copy it now. It is not shown again.</AlertTitle>
					<AlertDescription className='font-mono text-label break-all'>{issued}</AlertDescription>
				</Alert>
			) : null}

			<FormSection
				title='Create a token'
				description='Sent as a bearer token; it can do everything this account can.'
				icon={IconKey}
				hint='Name it after what will hold it.'
				actions={
					<Button type='submit' variant='primary' disabled={create.isPending}>
						<IconPlus />
						Create token
					</Button>
				}
				onSave={() => create.mutate()}
			>
				<ErrorText error={create.error} />
				<div className='max-w-xs'>
					<Field label='Token name'>
						<Input required value={name} onChange={event => setName(event.target.value)} placeholder='ci' />
					</Field>
				</div>
			</FormSection>
		</div>
	)
}
