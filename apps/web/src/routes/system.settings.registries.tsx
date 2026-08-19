import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, ErrorText, Field, Refresh, Section } from '../components/primitives'
import { api, type Registry } from '../lib/api'
import { since } from '../lib/format'

export const Route = createFileRoute('/system/settings/registries')({ component: Registries })

function registryTableColumns(remove: (id: string) => void): Columns<Registry> {
	const cell = columnsFor<Registry>()
	return [
		cell.accessor(registry => registry.name, { id: 'name', header: 'Name' }),
		cell.accessor(registry => registry.url, { id: 'url', header: 'URL', meta: { mono: true } }),
		cell.accessor(registry => registry.username, { id: 'username', header: 'Username', meta: { mono: true } }),
		cell.accessor(registry => registry.created_at, {
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

function Registries() {
	const queryClient = useQueryClient()
	const registries = useQuery({ queryKey: ['registries'], queryFn: api.registries })
	const [form, setForm] = useState({ name: '', url: '', username: '', password: '' })

	const create = useMutation({
		mutationFn: () => api.createRegistry(form),
		onSuccess: async () => {
			setForm({ name: '', url: '', username: '', password: '' })
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
		<Section
			title='Private registries'
			description='credentials are encrypted at rest'
			actions={<Refresh onClick={() => registries.refetch()} busy={registries.isFetching} />}
		>
			<DataTable
				data={registries.data ?? []}
				columns={columns}
				loading={registries.isLoading}
				getRowId={registry => registry.id}
				empty='No registries configured. Public images work without one.'
			/>

			<form
				className='mt-3 grid max-w-4xl gap-x-6 md:grid-cols-4'
				onSubmit={event => {
					event.preventDefault()
					create.mutate()
				}}
			>
				<Field label='Name'>
					<input
						required
						value={form.name}
						onChange={event => setForm({ ...form, name: event.target.value })}
					/>
				</Field>
				<Field label='Registry URL'>
					<input
						required
						placeholder='ghcr.io'
						value={form.url}
						onChange={event => setForm({ ...form, url: event.target.value })}
					/>
				</Field>
				<Field label='Username'>
					<input
						required
						value={form.username}
						onChange={event => setForm({ ...form, username: event.target.value })}
					/>
				</Field>
				<Field label='Token'>
					<input
						required
						type='password'
						value={form.password}
						onChange={event => setForm({ ...form, password: event.target.value })}
					/>
				</Field>
				<div className='md:col-span-4'>
					<ErrorText error={create.error ?? remove.error} />
					<Button type='submit' disabled={create.isPending}>
						{create.isPending ? 'Verifying…' : 'Add registry'}
					</Button>
				</div>
			</form>
		</Section>
	)
}
