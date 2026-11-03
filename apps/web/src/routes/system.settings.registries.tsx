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

function RegistryRow({ registry, remove }: { registry: Registry; remove: (id: string) => void }) {
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
				action='Remove'
				onConfirm={() => remove(registry.id)}
			>
				<IconButton icon={IconTrash} label='Remove' />
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
				actions={
					<>
						<Refresh onClick={() => registries.refetch()} busy={registries.isFetching} />
						<Button variant='primary' onClick={() => setAdding(true)}>
							<IconPlus size={16} stroke={1.75} />
							Add registry
						</Button>
					</>
				}
			>
				<ErrorText error={remove.error ?? registries.error} />
				{listed.length === 0 ? (
					<div className='rounded-surface border bg-surface'>
						<EmptyState
							icon={IconBrandDocker}
							title={registries.isLoading ? 'Loading registries' : 'No registries configured'}
							description='Public images work without one.'
						/>
					</div>
				) : (
					<IntegrationList>
						{listed.map(registry => (
							<RegistryRow key={registry.id} registry={registry} remove={removeRegistry} />
						))}
					</IntegrationList>
				)}
			</Section>

			<FormDialog
				open={adding}
				onOpenChange={setAdding}
				title='Add a registry'
				description='A token or password with pull access. The login is verified before it is stored.'
				action={create.isPending ? 'Verifying…' : 'Add registry'}
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
			</FormDialog>
		</div>
	)
}
