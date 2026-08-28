import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { MetricCard, type Point, ratesOf, seriesOf, useHistory } from '../components/metric-chart'
import { Button, Cells, Fact, Facts, Section } from '../components/primitives'
import { api, type ContainerStats, type ServicePoint } from '../lib/api'
import { bytes, percent, since } from '../lib/format'
import { useEventSource } from '../lib/sse'
import { useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/')({
	component: ServiceOverview,
})

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

function ServiceOverview() {
	const { serviceId } = Route.useParams()
	const [stats, setStats] = useState<Sample | null>(null)

	const service = useService(serviceId)
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

	return (
		<>
			{service.data?.type === 'database' ? <DatabasePanels serviceId={serviceId} /> : null}
			<Section title='Overview'>
				<Cells>
					<MetricCard
						label='CPU'
						value={current ? percent(current.cpu_percent) : '-'}
						series={[seriesOf(history, sample => sample.cpu_percent)]}
						max={100}
						format={([cpu]) => percent(cpu)}
					/>
					<MetricCard
						label='Memory'
						value={current ? bytes(current.memory_usage) : '-'}
						series={[seriesOf(history, sample => sample.memory_usage)]}
						max={current?.memory_limit}
						format={([used]) => bytes(used)}
						hint={current ? `of ${bytes(current.memory_limit)}` : undefined}
					/>
					<MetricCard
						label='Network'
						value={`${bytes(latest(received))} / ${bytes(latest(sent))}`}
						series={[received, sent]}
						format={([rx, tx]) => `${bytes(rx)} / ${bytes(tx)}`}
						hint='rx / tx per second'
					/>
					<MetricCard
						label='Block i/o'
						value={`${bytes(latest(read))} / ${bytes(latest(written))}`}
						series={[read, written]}
						format={([r, w]) => `${bytes(r)} / ${bytes(w)}`}
						hint='read / write per second'
					/>
				</Cells>
				<div className='mt-4 grid items-start gap-x-7 lg:grid-cols-2'>
					<Facts>
						<Fact label='Image' value={service.data?.running_image || service.data?.image || '-'} />
						<Fact
							label='Created'
							value={service.data?.created_unix ? since(service.data.created_unix) : '-'}
						/>
						<Fact label='Restarts' value={service.data?.restart_count ?? 0} />
					</Facts>
					<Facts>
						<Fact label='Health' value={service.data?.health || 'no healthcheck'} />
						<Fact label='PIDs' value={stats?.pids ?? '-'} />
						<Fact label='Container' value={service.data?.container_id?.slice(0, 12) || '-'} />
					</Facts>
				</div>
			</Section>
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
				<Facts>
					<Fact label='Host' value={data.host} />
					<Fact label='Port' value={data.port} />
					{data.database ? <Fact label='Database' value={data.database} /> : null}
					{data.user ? <Fact label='User' value={data.user} /> : null}
					<Fact label='Password' value={mask(data.password)} />
					<Fact label='URL' value={revealed ? data.url : data.url.replace(data.password, '•••')} />
				</Facts>
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
				<Facts>
					<Fact label='Engine' value={data.engine} />
					<Fact label='Image' value={data.image} />
					<Fact label='Volume' value={data.data_volume} />
					<Fact label='Other tags' value={upgrades.slice(0, 4).join(', ') || '-'} />
				</Facts>
				<p className='mt-2 text-label text-muted-foreground'>
					Change the image in Settings, then Deploy this service to move versions.
				</p>
			</Section>
		</div>
	)
}
