import { useState } from 'react'
import { IconBrandDocker, IconPlus, IconTrash } from '@tabler/icons-react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
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
} from '../components/primitives'
import { api, type Registry } from '../lib/api'
import { preload } from '../lib/queries'

const registriesQuery = queryOptions({ queryKey: ['registries'], queryFn: api.registries })

export const Route = createFileRoute('/system/settings/registries')({
	loader: ({ context: { queryClient } }) => preload(queryClient, registriesQuery),
	component: Registries,
})

function RegistryRow({
	registry,
	remove,
	removing,
}: {
	registry: Registry
	remove: (id: string) => void
	removing: string | undefined
}) {
	return (
		<IntegrationRow
			icon={IconBrandDocker}
			name={registry.name}
			kind={registry.username}
			description={
				<>
					<span className='font-mono'>{registry.url}</span>, added <RelativeTime at={registry.created_at} />
				</>
			}
		>
			<Confirm
				title={`Remove ${registry.name}?`}
				description='Services pulling from it with these credentials will fail on their next deploy.'
				action='Remove registry'
				onConfirm={() => remove(registry.id)}
			>
				<IconButton
					icon={IconTrash}
					label={`Remove ${registry.name}`}
					loading={removing === registry.id}
					disabled={removing !== undefined}
				/>
			</Confirm>
		</IntegrationRow>
	)
}

const emptyForm = { name: '', url: '', username: '', password: '' }

function Registries() {
	const queryClient = useQueryClient()
	const registries = useQuery(registriesQuery)
	const [adding, setAdding] = useState(false)
	const [form, setForm] = useState(emptyForm)

	const create = useMutation({
		mutationFn: () => api.createRegistry(form),
		onSuccess: async () => {
			setForm(emptyForm)
			setAdding(false)
			await queryClient.invalidateQueries({ queryKey: ['registries'] })
		},
	})

	const remove = useMutation({
		mutationFn: api.deleteRegistry,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['registries'] }),
	})

	const { mutate: removeRegistry } = remove
	const listed = registries.data ?? []

	return (
		<div className='max-w-3xl'>
			<Section
				title='Private registries'
				total={registries.data?.length}
				actions={
					<>
						<Refresh onClick={() => registries.refetch()} />
						<Button variant='primary' size='sm' onClick={() => setAdding(true)}>
							<IconPlus size={16} stroke={1.75} />
							Add registry
						</Button>
					</>
				}
			>
				<ErrorText error={remove.error} />
				<ErrorText error={registries.error} />
				{listed.length > 0 ? (
					<IntegrationList>
						{listed.map(registry => (
							<RegistryRow
								key={registry.id}
								registry={registry}
								remove={removeRegistry}
								removing={remove.isPending ? remove.variables : undefined}
							/>
						))}
					</IntegrationList>
				) : registries.error ? null : (
					<ListPlaceholder loading={registries.isLoading} label='Loading registries'>
						<EmptyState
							icon={IconBrandDocker}
							title='No registries configured'
							description='Public images work without one. Add registry signs in to a private one.'
						/>
					</ListPlaceholder>
				)}
			</Section>

			<FormDialog
				open={adding}
				onOpenChange={open => {
					setAdding(open)
					if (!open) setForm(emptyForm)
				}}
				title='Add a registry'
				description='A token or password with pull access. The login is verified before it is stored.'
				action='Add registry'
				icon={IconPlus}
				mutation={create}
				onSubmit={() => create.mutate()}
			>
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
							mono
							required
							placeholder='ghcr.io'
							value={form.url}
							onChange={event => setForm({ ...form, url: event.target.value })}
						/>
					</Field>
					<Field label='Username'>
						<Input
							mono
							required
							autoComplete='off'
							value={form.username}
							onChange={event => setForm({ ...form, username: event.target.value })}
						/>
					</Field>
					<Field label='Token'>
						<Input
							mono
							required
							type='password'
							autoComplete='new-password'
							value={form.password}
							onChange={event => setForm({ ...form, password: event.target.value })}
						/>
					</Field>
				</div>
			</FormDialog>
		</div>
	)
}
