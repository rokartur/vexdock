import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { LogViewer } from '../components/log-viewer'
import { MetricCard, type Point, ratesOf, seriesOf, useHistory } from '../components/metric-chart'
import { Button, ErrorText, Field, Section } from '../components/primitives'
import { Terminal } from '../components/terminal'
import { api, type ContainerStats, type Service, type ServicePoint } from '../lib/api'
import { fromDotenv, toDotenv } from '../lib/dotenv'
import { bytes, percent, since } from '../lib/format'
import { useEventSource } from '../lib/sse'

export const Route = createFileRoute('/projects/$projectId/services/$serviceId')({ component: ServiceDetail })

type Tab = 'overview' | 'environment' | 'logs' | 'terminal' | 'settings'

/**
 * A service the project's own compose file declares is described, never
 * rewritten: it has no environment of its own and deleting it means editing
 * that file.
 */
const tabsFor = (service: Service | undefined): Tab[] =>
	service && service.source_type !== 'derived'
		? ['overview', 'environment', 'logs', 'terminal', 'settings']
		: ['overview', 'logs', 'terminal']

/**
 * Recorded buckets and live SSE samples share one shape, stamped in
 * milliseconds. Only live samples carry a process count; it is not recorded.
 */
type Sample = ServicePoint & { pids?: number }

const toMillis = (point: ServicePoint): Sample => ({ ...point, at: point.at * 1000 })

/** Latest per-second rate, or zero while the window is still filling. */
function latest(rates: Point[]) {
	return rates.at(-1)?.value ?? 0
}

function ServiceDetail() {
	const { projectId, serviceId } = Route.useParams()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [tab, setTab] = useState<Tab>('overview')
	const [stats, setStats] = useState<Sample | null>(null)

	const service = useQuery({
		queryKey: ['service', serviceId],
		queryFn: () => api.service(serviceId),
		refetchInterval: 5000,
	})
	const recorded = useQuery({
		queryKey: ['service', serviceId, 'metrics'],
		queryFn: () => api.serviceMetrics(serviceId, '30m'),
	})

	const running = service.data?.state === 'running'
	useEventSource(running ? `/api/services/${serviceId}/stats` : null, {
		stats: data => setStats({ ...(data as ContainerStats), at: Date.now() }),
	})

	const history = useHistory(
		stats,
		useMemo(() => (recorded.data ?? []).map(toMillis), [recorded.data]),
	)
	const received = ratesOf(history, sample => sample.network_rx)
	const sent = ratesOf(history, sample => sample.network_tx)
	const read = ratesOf(history, sample => sample.block_read)
	const written = ratesOf(history, sample => sample.block_write)
	// Until the first live sample lands, the newest recorded bucket is the reading.
	const current = stats ?? history.at(-1)

	const act = useMutation({
		mutationFn: (action: 'start' | 'stop' | 'restart') => api.serviceAction(serviceId, action),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', serviceId] }),
	})
	const deploy = useMutation({
		mutationFn: () => api.deployService(serviceId),
		onSuccess: async deployment => {
			await queryClient.invalidateQueries({ queryKey: ['service', serviceId] })
			await navigate({ to: '/deployments/$deploymentId', params: { deploymentId: deployment.id } })
		},
	})

	const tabs = tabsFor(service.data)
	const canDeploy = Boolean(service.data && service.data.source_type !== 'unconfigured')

	return (
		<>
			{/* The name and its state live in the header trail's service picker. */}
			<div className='mb-4 flex flex-wrap justify-end gap-2'>
				<Button variant='primary' onClick={() => deploy.mutate()} disabled={!canDeploy || deploy.isPending}>
					{deploy.isPending ? 'Starting…' : 'Deploy'}
				</Button>
				<Button onClick={() => act.mutate('restart')} disabled={!running}>
					Restart
				</Button>
				<Button onClick={() => act.mutate('stop')} disabled={!running || act.isPending}>
					Stop
				</Button>
			</div>
			<ErrorText error={deploy.error ?? act.error} />

			<nav className='mb-4 flex gap-4 border-b border-border'>
				{tabs.map(item => (
					<button
						key={item}
						type='button'
						onClick={() => setTab(item)}
						className={`-mb-px border-b px-0.5 pb-1.5 text-body capitalize ${
							tab === item
								? 'border-foreground text-foreground'
								: 'border-transparent text-muted-foreground hover:text-foreground'
						}`}
					>
						{item}
					</button>
				))}
			</nav>

			{tab === 'overview' ? (
				<>
					{service.data?.type === 'database' ? <DatabasePanels serviceId={serviceId} /> : null}
					<Section title='Overview'>
						<div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-4'>
							<MetricCard
								label='CPU'
								value={current ? percent(current.cpu_percent) : '-'}
								series={[seriesOf(history, sample => sample.cpu_percent)]}
								max={100}
								format={([cpu]) => percent(cpu)}
							/>
							<MetricCard
								label='Memory'
								value={
									current ? `${bytes(current.memory_usage)} / ${bytes(current.memory_limit)}` : '-'
								}
								series={[seriesOf(history, sample => sample.memory_usage)]}
								max={current?.memory_limit}
								format={([used]) => `${bytes(used)} / ${bytes(current?.memory_limit)}`}
							/>
							<MetricCard
								label='Network'
								value={`${bytes(latest(received))}/s rx · ${bytes(latest(sent))}/s tx`}
								series={[received, sent]}
								format={([rx, tx]) => `${bytes(rx)}/s rx · ${bytes(tx)}/s tx`}
							/>
							<MetricCard
								label='Block i/o'
								value={`${bytes(latest(read))}/s r · ${bytes(latest(written))}/s w`}
								series={[read, written]}
								format={([r, w]) => `${bytes(r)}/s r · ${bytes(w)}/s w`}
							/>
						</div>
						<dl className='mt-4 grid grid-cols-2 gap-x-8 gap-y-1 border-t border-border pt-2 lg:grid-cols-3'>
							<Item label='Image' value={service.data?.running_image || service.data?.image || '-'} />
							<Item
								label='Created'
								value={service.data?.created_unix ? since(service.data.created_unix) : '-'}
							/>
							<Item label='Restarts' value={String(service.data?.restart_count ?? 0)} />
							<Item label='Health' value={service.data?.health || 'no healthcheck'} />
							<Item label='PIDs' value={stats?.pids === undefined ? '-' : String(stats.pids)} />
							<Item label='Container' value={service.data?.container_id?.slice(0, 12) || '-'} />
						</dl>
					</Section>
				</>
			) : null}

			{tab === 'environment' ? <ServiceEnvironment serviceId={serviceId} /> : null}

			{tab === 'logs' ? <LogViewer url={`/api/services/${serviceId}/logs`} /> : null}

			{tab === 'terminal' ? (
				running ? (
					<Terminal url={terminalUrl(serviceId)} />
				) : (
					<p className='text-body text-muted-foreground'>Start the service to open a terminal.</p>
				)
			) : null}

			{tab === 'settings' && service.data ? (
				<ServiceSettings projectId={projectId} service={service.data} />
			) : null}
		</>
	)
}

/**
 * What you open a database for: the credentials to reach it, and the image it
 * runs. The credentials are read back out of the service's own environment and
 * the image off the service itself, so both are what the container will
 * actually start with rather than what the catalogue currently defaults to.
 */
function DatabasePanels({ serviceId }: { serviceId: string }) {
	const [revealed, setRevealed] = useState(false)
	const connection = useQuery({
		queryKey: ['service', serviceId, 'database'],
		queryFn: () => api.serviceDatabase(serviceId),
	})

	const { data } = connection
	if (!data) return null

	const mask = (value: string) => (revealed ? value : '•'.repeat(12))
	const upgrades = data.versions.filter(tag => !data.image.endsWith(`:${tag}`))

	return (
		<div className='mb-4 grid gap-4 lg:grid-cols-2'>
			<Section title='Connection'>
				<dl className='grid grid-cols-2 gap-x-8 gap-y-1'>
					<Item label='Host' value={data.host} />
					<Item label='Port' value={String(data.port)} />
					{data.database ? <Item label='Database' value={data.database} /> : null}
					{data.user ? <Item label='User' value={data.user} /> : null}
					<Item label='Password' value={mask(data.password)} />
					<Item label='URL' value={revealed ? data.url : data.url.replace(data.password, '•••')} />
				</dl>
				<div className='mt-2 flex items-center gap-3'>
					<Button variant='ghost' onClick={() => setRevealed(value => !value)}>
						{revealed ? 'Hide' : 'Reveal'}
					</Button>
					<p className='text-label text-muted-foreground'>
						Reachable under this hostname from every other service in this project.
					</p>
				</div>
			</Section>

			<Section title='Engine'>
				<dl className='grid grid-cols-2 gap-x-8 gap-y-1'>
					<Item label='Engine' value={data.engine} />
					<Item label='Image' value={data.image} />
					<Item label='Volume' value={data.data_volume} />
					<Item label='Other tags' value={upgrades.slice(0, 4).join(', ') || '-'} />
				</dl>
				<p className='mt-2 text-label text-muted-foreground'>
					Change the image in Settings, then Deploy this service to move versions.
				</p>
			</Section>
		</div>
	)
}

/**
 * Managed services get their own .env file, so their credentials never collide
 * with a sibling running the same engine.
 */
function ServiceEnvironment({ serviceId }: { serviceId: string }) {
	const queryClient = useQueryClient()
	const [text, setText] = useState('')

	const environment = useQuery({
		queryKey: ['service', serviceId, 'environment'],
		queryFn: () => api.serviceVariables(serviceId),
	})

	useEffect(() => {
		if (environment.data) setText(toDotenv(environment.data))
	}, [environment.data])

	const save = useMutation({
		mutationFn: () => api.saveServiceVariables(serviceId, fromDotenv(text, environment.data ?? [])),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', serviceId, 'environment'] }),
	})

	return (
		<Section
			title='Environment variables'
			description='written to this service’s own .env with 0600 permissions'
			onSave={() => save.mutate()}
			actions={
				<Button variant='primary' onClick={() => save.mutate()} disabled={save.isPending}>
					{save.isPending ? 'Saving…' : 'Save'}
				</Button>
			}
		>
			<ErrorText error={save.error} />
			<textarea
				rows={18}
				value={text}
				placeholder='KEY=value'
				onChange={event => setText(event.target.value)}
				className='font-mono text-body'
				spellCheck={false}
			/>
			<p className='mt-1 text-label text-muted-foreground'>One KEY=value per line. Redeploy to apply.</p>
		</Section>
	)
}

function ServiceSettings({ projectId, service }: { projectId: string; service: Service }) {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [image, setImage] = useState(service.image)
	const [repositoryUrl, setRepositoryUrl] = useState(service.repository_url)
	const [branch, setBranch] = useState(service.branch)
	const [buildPath, setBuildPath] = useState(service.build_path)
	const [fragment, setFragment] = useState(service.compose_fragment)
	const [confirmDelete, setConfirmDelete] = useState(false)

	// An application arrives here as a bare name, so this page is where its
	// source gets answered. Once saved the answer sticks and the select goes
	// away: the checkout and the env file already hang off it.
	const pending = service.source_type === 'unconfigured'
	const [source, setSource] = useState<'git' | 'image'>('git')
	const showing = pending ? source : service.source_type

	const save = useMutation({
		mutationFn: () =>
			api.updateService(service.id, {
				...(pending ? { source_type: source } : {}),
				...(showing === 'git'
					? { repository_url: repositoryUrl, branch: branch || 'main', build_path: buildPath }
					: {}),
				...(showing === 'image' ? { image } : {}),
				...(showing === 'compose' ? { compose_fragment: fragment } : {}),
			}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', service.id] }),
	})

	const remove = useMutation({
		mutationFn: () => api.deleteService(service.id),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['services', projectId] })
			await navigate({ to: '/projects/$projectId', params: { projectId } })
		},
	})

	return (
		<>
			<Section
				title='Settings'
				description='applied on the next deploy'
				onSave={() => save.mutate()}
				actions={
					<Button variant='primary' onClick={() => save.mutate()} disabled={save.isPending}>
						{save.isPending ? 'Saving…' : 'Save'}
					</Button>
				}
			>
				<div className='grid gap-x-6 md:grid-cols-2'>
					{pending ? (
						<Field label='Source' hint='Set once. To change it later, delete the service and add it again.'>
							<select
								value={source}
								onChange={event => setSource(event.target.value === 'image' ? 'image' : 'git')}
							>
								<option value='git'>Git repository</option>
								<option value='image'>Docker image</option>
							</select>
						</Field>
					) : null}
					{showing === 'git' ? (
						<>
							<Field label='Repository'>
								<input value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} />
							</Field>
							<Field label='Branch'>
								<input value={branch} onChange={event => setBranch(event.target.value)} />
							</Field>
							<Field label='Build path'>
								<input value={buildPath} onChange={event => setBuildPath(event.target.value)} />
							</Field>
						</>
					) : null}
					{showing === 'image' ? (
						<Field
							label='Image'
							hint={
								service.type === 'database'
									? 'Changing the tag is how a database moves version.'
									: undefined
							}
						>
							<input value={image} onChange={event => setImage(event.target.value)} />
						</Field>
					) : null}
				</div>
				{showing === 'compose' ? (
					<Field label='Compose fragment'>
						<textarea
							rows={10}
							value={fragment}
							onChange={event => setFragment(event.target.value)}
							className='font-mono text-body'
							spellCheck={false}
						/>
					</Field>
				) : null}
				<ErrorText error={save.error} />
			</Section>

			<Section title='Delete service' description='its named volume is kept'>
				<ErrorText error={remove.error} />
				{confirmDelete ? (
					<div className='flex gap-2'>
						<Button variant='danger' onClick={() => remove.mutate()} disabled={remove.isPending}>
							{remove.isPending ? 'Deleting…' : `Delete ${service.compose_service_name}`}
						</Button>
						<Button variant='ghost' onClick={() => setConfirmDelete(false)}>
							Cancel
						</Button>
					</div>
				) : (
					<Button variant='danger' onClick={() => setConfirmDelete(true)}>
						Delete service
					</Button>
				)}
				<p className='mt-1 text-label text-muted-foreground'>
					Removes it from the compose overlay and drops its environment. The data volume stays, so recreating
					the service under the same name picks it back up.
				</p>
			</Section>
		</>
	)
}

function terminalUrl(serviceId: string): string {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	return `${protocol}//${window.location.host}/api/services/${serviceId}/terminal`
}

function Item({ label, value }: { label: string; value: string }) {
	return (
		<div className='py-1'>
			<dt className='text-label tracking-wide text-muted-foreground uppercase'>{label}</dt>
			<dd className='font-mono text-body break-all'>{value}</dd>
		</div>
	)
}
