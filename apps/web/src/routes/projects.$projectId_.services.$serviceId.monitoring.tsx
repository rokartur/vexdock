import { useMemo, useState } from 'react'
import { IconActivity, IconAffiliate, IconCpu, IconDatabase, IconServer } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { MetricCard, type Point, ratesOf, seriesOf, totalOf, useHistory } from '../components/metric-chart'
import { Cells, EmptyState, Fact, Facts, RelativeTime, Section, Segmented } from '../components/primitives'
import { api, type ContainerStats, type MetricWindow, type ServicePoint } from '../lib/api'
import { bytes, percent } from '../lib/format'
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

const MINUTE = 60 * 1000

/** The windows the manager answers for, oldest reach last. */
const windows = [
	{ value: '30m', label: '30m', ms: 30 * MINUTE },
	{ value: '1h', label: '1h', ms: 60 * MINUTE },
	{ value: '6h', label: '6h', ms: 6 * 60 * MINUTE },
	{ value: '24h', label: '24h', ms: 24 * 60 * MINUTE },
	{ value: '7d', label: '7d', ms: 7 * 24 * 60 * MINUTE },
] as const satisfies readonly { value: MetricWindow; label: string; ms: number }[]

/** Latest per-second rate, or zero while the window is still filling. */
function latest(rates: Point[]) {
	return rates.at(-1)?.value ?? 0
}

function peakOf(points: Point[]) {
	let peak = 0
	for (const point of points) peak = Math.max(peak, point.value)
	return peak
}

function meanOf(points: Point[]) {
	let sum = 0
	for (const point of points) sum += point.value
	return points.length === 0 ? 0 : sum / points.length
}

const perSecond = (value: number | undefined) => `${bytes(value)}/s`

/** A series' colour in a two-line chart, matching what `MetricCard` strokes it with. */
function Key({ muted = false, children }: { muted?: boolean; children: string }) {
	return (
		<span className='inline-flex items-center gap-1'>
			<span className={`inline-block size-2 rounded-full ${muted ? 'bg-muted-foreground' : 'bg-chart-1'}`} />
			{children}
		</span>
	)
}

/**
 * Four charts over one window the reader picks, each with what that window adds up to, then the container facts
 * the strip above does not already carry. Live samples extend the recorded window once a minute while it runs.
 */
function ServiceMonitoring() {
	const { serviceId } = Route.useParams()
	const [range, setRange] = useState<MetricWindow>('30m')
	const [stats, setStats] = useState<Sample | null>(null)
	const span = windows.find(option => option.value === range)?.ms ?? windows[0].ms

	const service = useService(serviceId)
	const recorded = useQuery({
		queryKey: ['service', serviceId, 'metrics', range],
		queryFn: () => api.serviceMetrics(serviceId, range),
	})

	const running = service.data?.state === 'running'
	useEventSource(running ? `/api/services/${serviceId}/stats` : null, {
		stats: data => setStats({ ...(data as ContainerStats), at: Date.now() }),
	})

	const history = useHistory(
		stats,
		useMemo(() => (recorded.data ?? []).map(toMillis), [recorded.data]),
		span,
	)
	const cpu = seriesOf(history, sample => sample.cpu_percent)
	const memory = seriesOf(history, sample => sample.memory_usage)
	const received = ratesOf(history, sample => sample.network_rx)
	const sent = ratesOf(history, sample => sample.network_tx)
	const read = ratesOf(history, sample => sample.block_read)
	const written = ratesOf(history, sample => sample.block_write)
	// Until the first live sample lands, the newest recorded bucket is the reading.
	const current = stats ?? history.at(-1)
	const label = windows.find(option => option.value === range)?.label ?? range

	return (
		<Section
			title='Monitoring'
			description={running ? 'live, a reading a minute' : 'not running, recorded history only'}
			actions={<Segmented value={range} onChange={setRange} options={windows} />}
		>
			{history.length === 0 ? (
				<div className='rounded-xl border bg-card raised'>
					<EmptyState
						icon={IconActivity}
						title={recorded.isPending ? 'Loading readings…' : `No readings in the last ${label}`}
						description='The manager records every running service once a minute.'
					/>
				</div>
			) : (
				<Cells className='grid-cols-1 lg:grid-cols-2'>
					<MetricCard
						label='CPU'
						icon={IconCpu}
						value={current ? percent(current.cpu_percent) : '-'}
						series={[cpu]}
						format={([value]) => percent(value)}
						hint={`avg ${percent(meanOf(cpu))} · peak ${percent(peakOf(cpu))} · 100% is one core`}
						windowLabel={`last ${label}`}
						height={140}
						axis={{ tick: percent, floor: 5 }}
					/>
					<MetricCard
						label='Memory'
						icon={IconServer}
						value={current ? bytes(current.memory_usage) : '-'}
						series={[memory]}
						format={([value]) => bytes(value)}
						hint={`of ${bytes(current?.memory_limit)} · peak ${bytes(peakOf(memory))}`}
						windowLabel={`last ${label}`}
						height={140}
						axis={{ tick: bytes, floor: 1024 * 1024, base: 1024 }}
					/>
					<MetricCard
						label='Network'
						icon={IconAffiliate}
						value={`${perSecond(latest(received))} / ${perSecond(latest(sent))}`}
						series={[received, sent]}
						format={([rx, tx]) => `in ${perSecond(rx)} · out ${perSecond(tx)}`}
						hint={
							<span className='inline-flex gap-3'>
								<Key>{`in ${bytes(totalOf(history, sample => sample.network_rx))}`}</Key>
								<Key muted>{`out ${bytes(totalOf(history, sample => sample.network_tx))}`}</Key>
							</span>
						}
						windowLabel={`last ${label}`}
						height={140}
						axis={{ tick: perSecond, floor: 1024, base: 1024 }}
					/>
					<MetricCard
						label='Block i/o'
						icon={IconDatabase}
						value={`${perSecond(latest(read))} / ${perSecond(latest(written))}`}
						series={[read, written]}
						format={([r, w]) => `read ${perSecond(r)} · write ${perSecond(w)}`}
						hint={
							<span className='inline-flex gap-3'>
								<Key>{`read ${bytes(totalOf(history, sample => sample.block_read))}`}</Key>
								<Key muted>{`written ${bytes(totalOf(history, sample => sample.block_write))}`}</Key>
							</span>
						}
						windowLabel={`last ${label}`}
						height={140}
						axis={{ tick: perSecond, floor: 1024, base: 1024 }}
					/>
				</Cells>
			)}
			{/* State, health, image and start time ride in the strip above every tab, so they are not repeated here. */}
			<div className='mt-4 grid items-start gap-x-7 lg:grid-cols-2'>
				<Facts>
					<Fact label='Container' value={service.data?.container_id?.slice(0, 12) || '-'} />
					<Fact label='Restarts' value={service.data?.restart_count ?? 0} />
				</Facts>
				<Facts>
					<Fact label='Processes' value={running && stats ? stats.pids : '-'} />
					<Fact
						label='Last reading'
						value={current ? <RelativeTime at={Math.floor(current.at / 1000)} /> : '-'}
					/>
				</Facts>
			</div>
		</Section>
	)
}
