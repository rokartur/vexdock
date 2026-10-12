import { useMemo, useState } from 'react'
import { IconArrowForwardUp, IconLock, IconPlugConnected, IconPlus, IconRocket, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
	api,
	type HostPort,
	type PortProtocol,
	type Service,
	type ServiceBasicAuthUser,
	type ServicePort,
	type ServiceRedirect,
} from '../lib/api'
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
	Status,
	Switch,
} from './primitives'

/** The service's redirects, basic auth and host ports. A compose fragment owns its own ports, so it gets no Ports card. */
export function ServiceRouting({ projectId, service }: { projectId: string; service: Service }) {
	return (
		<>
			<Redirects serviceId={service.id} />
			<BasicAuth serviceId={service.id} />
			{service.provider === 'raw' ? null : (
				<Ports projectId={projectId} serviceId={service.id} live={service.published_ports} />
			)}
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
		cell.accessor(redirect => redirect.replacement, {
			id: 'replacement',
			header: 'Replacement',
			meta: { mono: true },
		}),
		cell.accessor(redirect => (redirect.permanent ? '301 permanent' : '302 temporary'), {
			id: 'status',
			header: 'Status',
		}),
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

/** What a port row says about the host: open, or waiting on a deploy to open or close. */
export type PortState = 'open' | 'opens on deploy' | 'closes on deploy'

export type PortRow = {
	id: string
	published: number
	target: number
	protocol: string
	state: PortState
	/** The stored port this row is, absent on one only the container still holds. */
	storedId?: string
}

/**
 * The stored ports and the ones the container holds open, as one list. A port lands in the container on the next
 * deploy, so the two drift between an edit and that deploy: a stored port the container does not publish opens on
 * deploy, and a port the container still publishes after its row was removed closes on deploy. Without the second
 * kind the card would say "no ports" over a host port that is plainly open.
 */
export function portRows(stored: ServicePort[], live: HostPort[]): PortRow[] {
	// Docker lists a public port once per address family.
	const open = new Set(live.map(portKey))
	const rows: PortRow[] = stored.map(port => ({
		id: port.id,
		published: port.published,
		target: port.target,
		protocol: port.protocol,
		state: open.has(portKey(port)) ? 'open' : 'opens on deploy',
		storedId: port.id,
	}))
	const known = new Set(stored.map(portKey))
	const seen = new Set<string>()
	for (const port of live) {
		const key = portKey(port)
		if (known.has(key) || seen.has(key)) continue
		seen.add(key)
		rows.push({
			id: `live:${key}`,
			published: port.published,
			target: port.target,
			protocol: port.protocol,
			state: 'closes on deploy',
		})
	}
	return rows.toSorted((a, b) => a.published - b.published || a.protocol.localeCompare(b.protocol))
}

const portKey = (port: { published: number; target: number; protocol: string }) =>
	`${port.published}:${port.target}/${port.protocol}`

function Ports({ projectId, serviceId, live }: { projectId: string; serviceId: string; live: HostPort[] }) {
	const [adding, setAdding] = useState(false)
	const [published, setPublished] = useState('')
	const [target, setTarget] = useState('')
	const [protocol, setProtocol] = useState<PortProtocol>('tcp')
	const navigate = useNavigate()
	const queryClient = useQueryClient()
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
	// The same deploy the General tab starts: the container is recreated with the stored ports and nothing else.
	const deploy = useMutation({
		mutationFn: () => api.deployService(serviceId),
		onSuccess: async deployment => {
			await queryClient.invalidateQueries({ queryKey: ['service', serviceId] })
			await navigate({
				to: '/projects/$projectId/services/$serviceId/deployments',
				params: { projectId, serviceId },
				search: previous => ({ ...previous, deployment: deployment.id }),
			})
		},
	})

	const { mutate: removePort, isPending: removing } = remove
	const { mutate: startDeploy, isPending: deploying } = deploy
	const columns = useMemo(
		() => portColumns({ remove: removePort, removing, deploy: startDeploy, deploying }),
		[removePort, removing, startDeploy, deploying],
	)
	const rows = useMemo(() => portRows(list.data ?? [], live), [list.data, live])
	const pending = rows.some(row => row.state !== 'open')

	return (
		<FormSection
			title='Ports'
			icon={IconPlugConnected}
			hint={
				pending
					? 'Bypasses the proxy. The container still holds the ports it started with. Deploy to apply the change.'
					: 'Bypasses the proxy. Takes effect on the next deploy.'
			}
			actions={
				<>
					{pending ? (
						<Button onClick={() => startDeploy()} disabled={deploying}>
							<IconRocket />
							{deploying ? 'Starting…' : 'Deploy'}
						</Button>
					) : null}
					<Button variant='primary' onClick={() => setAdding(true)}>
						<IconPlus />
						Add port
					</Button>
				</>
			}
		>
			<ErrorText error={remove.error ?? deploy.error} />
			<DataTable
				data={rows}
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
							max={65_535}
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
							max={65_535}
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

/** The row actions of the Ports card: a stored port is removed, a port only the container holds is closed by a deploy. */
type PortActions = {
	remove: (id: string) => void
	removing: boolean
	deploy: () => void
	deploying: boolean
}

function portColumns({ remove, removing, deploy, deploying }: PortActions): Columns<PortRow> {
	const cell = columnsFor<PortRow>()
	return [
		cell.accessor(port => port.published, { id: 'published', header: 'Published', meta: { mono: true } }),
		cell.accessor(port => port.target, { id: 'target', header: 'Target', meta: { mono: true } }),
		cell.accessor(port => port.protocol.toUpperCase(), { id: 'protocol', header: 'Protocol' }),
		cell.accessor(port => port.state, {
			id: 'state',
			header: 'State',
			cell: ({ row }) => <Status value={row.original.state} />,
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => {
				const { storedId, published } = row.original
				// A port only the container holds has no row to drop; the only thing that closes it is the deploy that
				// recreates the container without it, so that is what its Remove does.
				if (storedId === undefined) {
					return (
						<Confirm
							title={`Close port ${published}?`}
							description='The port is no longer stored, but the container still holds it open. Deploying recreates the container without it.'
							action='Deploy'
							onConfirm={deploy}
						>
							<IconButton icon={IconTrash} label='Close' disabled={deploying} />
						</Confirm>
					)
				}
				return (
					<Confirm
						title={`Unpublish port ${published}?`}
						description='The host port closes on the next deploy.'
						action='Remove'
						onConfirm={() => remove(storedId)}
					>
						<IconButton icon={IconTrash} label='Remove' disabled={removing} />
					</Confirm>
				)
			},
		}),
	]
}
