import { useMemo, useState } from 'react'
import { IconAffiliate, IconCpu, IconDatabase, IconServer } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { MetricCard, type Point, ratesOf, seriesOf, useHistory } from '../components/metric-chart'
import { Cells, Fact, Facts, Section } from '../components/primitives'
import { api, type ContainerStats, type ServicePoint } from '../lib/api'
import { bytes, percent, since } from '../lib/format'
import { useEventSource } from '../lib/sse'
import { useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/monitoring')({
	component: ServiceMonitoring,
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

function ServiceMonitoring() {
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
		<Section title='Monitoring'>
			<Cells>
				<MetricCard
					label='CPU'
					icon={IconCpu}
					value={current ? percent(current.cpu_percent) : '-'}
					series={[seriesOf(history, sample => sample.cpu_percent)]}
					max={100}
					format={([cpu]) => percent(cpu)}
				/>
				<MetricCard
					label='Memory'
					icon={IconServer}
					value={current ? bytes(current.memory_usage) : '-'}
					series={[seriesOf(history, sample => sample.memory_usage)]}
					max={current?.memory_limit}
					format={([used]) => bytes(used)}
					hint={current ? `of ${bytes(current.memory_limit)}` : undefined}
				/>
				<MetricCard
					label='Network'
					icon={IconAffiliate}
					value={`${bytes(latest(received))} / ${bytes(latest(sent))}`}
					series={[received, sent]}
					format={([rx, tx]) => `${bytes(rx)} / ${bytes(tx)}`}
					hint='rx / tx per second'
				/>
				<MetricCard
					label='Block i/o'
					icon={IconDatabase}
					value={`${bytes(latest(read))} / ${bytes(latest(written))}`}
					series={[read, written]}
					format={([r, w]) => `${bytes(r)} / ${bytes(w)}`}
					hint='read / write per second'
				/>
			</Cells>
			<div className='mt-4 grid items-start gap-x-7 lg:grid-cols-2'>
				<Facts>
					<Fact label='Image' value={service.data?.running_image || service.data?.image || '-'} />
					<Fact label='Created' value={service.data?.created_unix ? since(service.data.created_unix) : '-'} />
					<Fact label='Restarts' value={service.data?.restart_count ?? 0} />
				</Facts>
				<Facts>
					<Fact label='Health' value={service.data?.health || 'no healthcheck'} />
					<Fact label='PIDs' value={stats?.pids ?? '-'} />
					<Fact label='Container' value={service.data?.container_id?.slice(0, 12) || '-'} />
				</Facts>
			</div>
		</Section>
	)
}
