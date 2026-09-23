import { useMemo, useState } from 'react'
import { IconArrowForwardUp, IconLock, IconPlugConnected, IconPlus, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type Columns, DataTable, columnsFor } from './data-table'
import {
	Button,
	Confirm,
	ErrorText,
	Field,
	FormDialog,
	FormSection,
	IconButton,
	Input,
	RelativeTime,
	Select,
	Switch,
} from './primitives'
import {
	api,
	type PortProtocol,
	type Service,
	type ServiceBasicAuthUser,
	type ServicePort,
	type ServiceRedirect,
} from '../lib/api'

/** The service's redirects, basic auth and host ports. A compose fragment owns its own ports, so it gets no Ports card. */
export function ServiceRouting({ service }: { service: Service }) {
	return (
		<>
			<Redirects serviceId={service.id} />
			<BasicAuth serviceId={service.id} />
			{service.provider === 'raw' ? null : <Ports serviceId={service.id} />}
		</>
	)
}

const presets = {
	custom: { regex: '', replacement: '' },
	www: { regex: '^https?://(?:www\\.)?(.+)', replacement: 'https://www.$1' },
	'non-www': { regex: '^https?://www\\.(.+)', replacement: 'https://$1' },
} as const

type Preset = keyof typeof presets

const presetOptions = [
	{ value: 'custom', label: 'Custom' },
	{ value: 'www', label: 'To www' },
	{ value: 'non-www', label: 'To non-www' },
] as const satisfies readonly { value: Preset; label: string }[]

function useServiceList<T>(serviceId: string, name: string, fetch: (id: string) => Promise<T[]>) {
	const queryClient = useQueryClient()
	const queryKey = ['service', serviceId, name]
	const list = useQuery({ queryKey, queryFn: () => fetch(serviceId) })
	return { list, refresh: () => queryClient.invalidateQueries({ queryKey }) }
}

function Redirects({ serviceId }: { serviceId: string }) {
	const [adding, setAdding] = useState(false)
	const [preset, setPreset] = useState<Preset>('custom')
	const [regex, setRegex] = useState('')
	const [replacement, setReplacement] = useState('')
	const [permanent, setPermanent] = useState(false)
	const { list, refresh } = useServiceList(serviceId, 'redirects', api.serviceRedirects)

	const create = useMutation({
		mutationFn: () => api.createServiceRedirect(serviceId, { regex, replacement, permanent }),
		onSuccess: async () => {
			setPreset('custom')
			setRegex('')
			setReplacement('')
			setPermanent(false)
			setAdding(false)
			await refresh()
		},
	})
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteServiceRedirect(serviceId, id),
		onSuccess: refresh,
	})

	const { mutate: removeRedirect, isPending: removing } = remove
	const columns = useMemo(() => redirectColumns(removeRedirect, removing), [removeRedirect, removing])

	return (
		<FormSection
			title='Redirects'
			description='Rewrites the full request URL on every domain of this service.'
			icon={IconArrowForwardUp}
			actions={
				<Button variant='primary' onClick={() => setAdding(true)}>
					<IconPlus />
					Add redirect
				</Button>
			}
		>
			<ErrorText error={remove.error} />
			<DataTable
				data={list.data ?? []}
				columns={columns}
				loading={list.isLoading}
				error={list.error}
				getRowId={redirect => redirect.id}
				empty='No redirects configured.'
			/>
			<FormDialog
				open={adding}
				onOpenChange={setAdding}
				title='Add redirect'
				action={create.isPending ? 'Adding…' : 'Add redirect'}
				icon={IconPlus}
				mutation={create}
				onSubmit={() => create.mutate()}
			>
				<Field label='Preset'>
					<Select
						label='Preset'
						value={preset}
						options={presetOptions}
						onChange={next => {
							setPreset(next)
							setRegex(presets[next].regex)
							setReplacement(presets[next].replacement)
						}}
					/>
				</Field>
				<Field label='Regex'>
					<Input
						mono
						required
						value={regex}
						onChange={event => setRegex(event.target.value)}
						placeholder='^https?://old\.example\.com/(.*)'
					/>
				</Field>
				<Field label='Replacement' hint='Use $1 for the first capture group.'>
					<Input
						mono
						required
						value={replacement}
						onChange={event => setReplacement(event.target.value)}
						placeholder='https://example.com/$1'
					/>
				</Field>
				<Switch label='Permanent' checked={permanent} onChange={setPermanent} />
			</FormDialog>
		</FormSection>
	)
}

function redirectColumns(remove: (id: string) => void, removing: boolean): Columns<ServiceRedirect> {
	const cell = columnsFor<ServiceRedirect>()
	return [
		cell.accessor(redirect => redirect.regex, { id: 'regex', header: 'Regex', meta: { mono: true } }),
		cell.accessor(redirect => redirect.replacement, { id: 'replacement', header: 'Replacement', meta: { mono: true } }),
		cell.accessor(redirect => (redirect.permanent ? '301 permanent' : '302 temporary'), { id: 'status', header: 'Status' }),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Confirm
					title='Remove this redirect?'
					description={`${row.original.regex} stops redirecting.`}
					action='Remove'
					onConfirm={() => remove(row.original.id)}
				>
					<IconButton icon={IconTrash} label='Remove' disabled={removing} />
				</Confirm>
			),
		}),
	]
}

function BasicAuth({ serviceId }: { serviceId: string }) {
	const [adding, setAdding] = useState(false)
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	const { list, refresh } = useServiceList(serviceId, 'basic-auth', api.serviceBasicAuth)

	const create = useMutation({
		mutationFn: () => api.createServiceBasicAuth(serviceId, { username, password }),
		onSuccess: async () => {
			setUsername('')
			setPassword('')
			setAdding(false)
			await refresh()
		},
	})
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteServiceBasicAuth(serviceId, id),
		onSuccess: refresh,
	})

	const { mutate: removeUser, isPending: removing } = remove
	const columns = useMemo(() => basicAuthColumns(removeUser, removing), [removeUser, removing])

	return (
		<FormSection
			title='Security'
			description='Asks for a username and password before the proxy lets a request through.'
			icon={IconLock}
			hint='With no users the service is open.'
			actions={
				<Button variant='primary' onClick={() => setAdding(true)}>
					<IconPlus />
					Add user
				</Button>
			}
		>
			<ErrorText error={remove.error} />
			<DataTable
				data={list.data ?? []}
				columns={columns}
				loading={list.isLoading}
				error={list.error}
				getRowId={user => user.id}
				empty='No users. Anyone can reach this service.'
			/>
			<FormDialog
				open={adding}
				onOpenChange={setAdding}
				title='Add user'
				action={create.isPending ? 'Adding…' : 'Add user'}
				icon={IconPlus}
				mutation={create}
				onSubmit={() => create.mutate()}
			>
				<div className='grid gap-x-6 md:grid-cols-2'>
					<Field label='Username'>
						<Input
							required
							autoComplete='off'
							value={username}
							onChange={event => setUsername(event.target.value)}
						/>
					</Field>
					<Field label='Password'>
						<Input
							required
							type='password'
							autoComplete='new-password'
							value={password}
							onChange={event => setPassword(event.target.value)}
						/>
					</Field>
				</div>
			</FormDialog>
		</FormSection>
	)
}

function basicAuthColumns(remove: (id: string) => void, removing: boolean): Columns<ServiceBasicAuthUser> {
	const cell = columnsFor<ServiceBasicAuthUser>()
	return [
		cell.accessor(user => user.username, { id: 'username', header: 'Username' }),
		cell.accessor(user => user.created_at, {
			id: 'created',
			header: 'Added',
			meta: { align: 'right' },
			cell: ({ row }) => <RelativeTime at={row.original.created_at} />,
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Confirm
					title={`Remove ${row.original.username}?`}
					description='Their password stops working right away.'
					action='Remove'
					onConfirm={() => remove(row.original.id)}
				>
					<IconButton icon={IconTrash} label='Remove' disabled={removing} />
				</Confirm>
			),
		}),
	]
}

const protocolOptions = [
	{ value: 'tcp', label: 'TCP' },
	{ value: 'udp', label: 'UDP' },
] as const satisfies readonly { value: PortProtocol; label: string }[]

function Ports({ serviceId }: { serviceId: string }) {
	const [adding, setAdding] = useState(false)
	const [published, setPublished] = useState('')
	const [target, setTarget] = useState('')
	const [protocol, setProtocol] = useState<PortProtocol>('tcp')
	const { list, refresh } = useServiceList(serviceId, 'ports', api.servicePorts)

	const create = useMutation({
		mutationFn: () =>
			api.createServicePort(serviceId, { published: Number(published), target: Number(target), protocol }),
		onSuccess: async () => {
			setPublished('')
			setTarget('')
			setProtocol('tcp')
			setAdding(false)
			await refresh()
		},
	})
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteServicePort(serviceId, id),
		onSuccess: refresh,
	})

	const { mutate: removePort, isPending: removing } = remove
	const columns = useMemo(() => portColumns(removePort, removing), [removePort, removing])

	return (
		<FormSection
			title='Ports'
			description='Publishes a container port on the server, bypassing the proxy.'
			icon={IconPlugConnected}
			hint='Takes effect on the next deploy.'
			actions={
				<Button variant='primary' onClick={() => setAdding(true)}>
					<IconPlus />
					Add port
				</Button>
			}
		>
			<ErrorText error={remove.error} />
			<DataTable
				data={list.data ?? []}
				columns={columns}
				loading={list.isLoading}
				error={list.error}
				getRowId={port => port.id}
				empty='No ports published.'
			/>
			<FormDialog
				open={adding}
				onOpenChange={setAdding}
				title='Publish a port'
				action={create.isPending ? 'Adding…' : 'Add port'}
				icon={IconPlus}
				mutation={create}
				onSubmit={() => create.mutate()}
			>
				<div className='grid gap-x-6 md:grid-cols-3'>
					<Field label='Published'>
						<Input
							required
							type='number'
							min={1}
							max={65535}
							value={published}
							onChange={event => setPublished(event.target.value)}
							placeholder='8080'
						/>
					</Field>
					<Field label='Target'>
						<Input
							required
							type='number'
							min={1}
							max={65535}
							value={target}
							onChange={event => setTarget(event.target.value)}
							placeholder='80'
						/>
					</Field>
					<Field label='Protocol'>
						<Select label='Protocol' value={protocol} options={protocolOptions} onChange={setProtocol} />
					</Field>
				</div>
			</FormDialog>
		</FormSection>
	)
}

function portColumns(remove: (id: string) => void, removing: boolean): Columns<ServicePort> {
	const cell = columnsFor<ServicePort>()
	return [
		cell.accessor(port => port.published, { id: 'published', header: 'Published', meta: { mono: true } }),
		cell.accessor(port => port.target, { id: 'target', header: 'Target', meta: { mono: true } }),
		cell.accessor(port => port.protocol.toUpperCase(), { id: 'protocol', header: 'Protocol' }),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Confirm
					title={`Unpublish port ${row.original.published}?`}
					description='The host port closes on the next deploy.'
					action='Remove'
					onConfirm={() => remove(row.original.id)}
				>
					<IconButton icon={IconTrash} label='Remove' disabled={removing} />
				</Confirm>
			),
		}),
	]
}
