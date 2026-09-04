import { useMemo, useState } from 'react'
import { IconBrandDocker, IconPlus, IconTrash } from '@tabler/icons-react'
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
} from '../components/primitives'
import { api, type Registry } from '../lib/api'
import { since } from '../lib/format'

export const Route = createFileRoute('/system/settings/registries')({ component: Registries })

function registryTableColumns(remove: (id: string) => void): Columns<Registry> {
	const cell = columnsFor<Registry>()
	return [
		cell.accessor(registry => registry.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2 font-medium'>
					<IconBrandDocker className='size-4 text-muted-foreground' />
					{row.original.name}
				</span>
			),
		}),
		cell.accessor(registry => registry.url, { id: 'url', header: 'URL', meta: { mono: true } }),
		cell.accessor(registry => registry.username, { id: 'username', header: 'Username', meta: { mono: true } }),
		cell.accessor(registry => registry.created_at, {
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
					description='Services pulling from it with these credentials will fail on their next deploy.'
					action='Remove'
					onConfirm={() => remove(row.original.id)}
				>
					<IconButton icon={IconTrash} label='Remove' />
				</Confirm>
			),
		}),
	]
}

const emptyForm = { name: '', url: '', username: '', password: '' }

function Registries() {
	const queryClient = useQueryClient()
	const registries = useQuery({ queryKey: ['registries'], queryFn: api.registries })
	const [form, setForm] = useState(emptyForm)

	const create = useMutation({
		mutationFn: () => api.createRegistry(form),
		onSuccess: async () => {
			setForm(emptyForm)
			await queryClient.invalidateQueries({ queryKey: ['registries'] })
		},
	})

	const remove = useMutation({
		mutationFn: (id: string) => api.deleteRegistry(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['registries'] }),
	})

	const { mutate: removeRegistry } = remove
	const columns = useMemo(() => registryTableColumns(removeRegistry), [removeRegistry])

	return (
		<div className='max-w-3xl'>
			<Section
				title='Private registries'
				description='credentials are encrypted at rest'
				actions={<Refresh onClick={() => registries.refetch()} busy={registries.isFetching} />}
			>
				<ErrorText error={remove.error} />
				<DataTable
					data={registries.data ?? []}
					columns={columns}
					loading={registries.isLoading}
					getRowId={registry => registry.id}
					empty='No registries configured. Public images work without one.'
				/>
			</Section>

			<FormSection
				title='Add a registry'
				description='A token or password with pull access.'
				icon={IconBrandDocker}
				hint='The login is verified before it is stored.'
				actions={
					<Button type='submit' variant='primary' disabled={create.isPending}>
						<IconPlus />
						{create.isPending ? 'Verifying…' : 'Add registry'}
					</Button>
				}
				onSave={() => create.mutate()}
			>
				<ErrorText error={create.error} />
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Name'>
						<Input
							required
							value={form.name}
							onChange={event => setForm({ ...form, name: event.target.value })}
						/>
					</Field>
					<Field label='Registry URL'>
						<Input
							required
							placeholder='ghcr.io'
							value={form.url}
							onChange={event => setForm({ ...form, url: event.target.value })}
						/>
					</Field>
					<Field label='Username'>
						<Input
							required
							value={form.username}
							onChange={event => setForm({ ...form, username: event.target.value })}
						/>
					</Field>
					<Field label='Token'>
						<Input
							required
							type='password'
							value={form.password}
							onChange={event => setForm({ ...form, password: event.target.value })}
						/>
					</Field>
				</div>
			</FormSection>
		</div>
	)
}
