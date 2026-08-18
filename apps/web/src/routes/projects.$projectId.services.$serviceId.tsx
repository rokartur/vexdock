import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { LogViewer } from '../components/log-viewer'
import { MetricCard, type Point, ratesOf, seriesOf, useHistory } from '../components/metric-chart'
import { Button, Section, Status } from '../components/primitives'
import { Terminal } from '../components/terminal'
import { api, type ContainerStats, type ServicePoint } from '../lib/api'
import { bytes, percent, since } from '../lib/format'
import { useEventSource } from '../lib/sse'

export const Route = createFileRoute('/projects/$projectId/services/$serviceId')({ component: ServiceDetail })

const tabs = ['overview', 'logs', 'terminal'] as const
type Tab = (typeof tabs)[number]

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

	return (
		<>
			<div className='mb-4 flex flex-wrap items-center justify-between gap-3'>
				<div className='flex items-baseline gap-3'>
					<Link
						to='/projects/$projectId'
						params={{ projectId }}
						className='text-body text-muted-foreground hover:text-foreground'
					>
						services
					</Link>
					<span className='text-muted-foreground'>/</span>
					<h2 className='text-title font-medium'>{service.data?.compose_service_name ?? serviceId}</h2>
					<Status value={service.data?.state || 'stopped'} />
				</div>
				<div className='flex gap-2'>
					<Button onClick={() => act.mutate('start')}>Start</Button>
					<Button onClick={() => act.mutate('restart')}>Restart</Button>
					<Button onClick={() => act.mutate('stop')}>Stop</Button>
				</div>
			</div>

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
							value={current ? `${bytes(current.memory_usage)} / ${bytes(current.memory_limit)}` : '-'}
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
						<Item label='Image' value={service.data?.image || '-'} />
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
			) : null}

			{tab === 'logs' ? <LogViewer url={`/api/services/${serviceId}/logs`} /> : null}

			{tab === 'terminal' ? (
				running ? (
					<Terminal url={terminalUrl(serviceId)} />
				) : (
					<p className='text-body text-muted-foreground'>Start the service to open a terminal.</p>
				)
			) : null}
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
