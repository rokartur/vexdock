import { type ReactNode, useMemo, useState } from 'react'
import {
	IconActivity,
	IconAffiliate,
	IconCpu,
	IconDatabase,
	IconPlayerPause,
	IconPlayerPlay,
	IconServer,
} from '@tabler/icons-react'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { AnimatedNumber } from '../components/animated-number'
import { MetricCard, type Point, ratesOf, seriesOf, totalOf, useHistory } from '../components/metric-chart'
import {
	Cell,
	Cells,
	EmptyState,
	ErrorText,
	Fact,
	Facts,
	IconButton,
	LoadingStatus,
	PendingReading,
	RelativeTime,
	Section,
	Segmented,
} from '../components/primitives'
import { api, type ContainerStats, type MetricWindow, type ServicePoint } from '../lib/api'
import { bytes, bytesTick, percent, percentTick } from '../lib/format'
import { preload } from '../lib/queries'
import { useEventSource } from '../lib/sse'
import { NotRunning, useService } from './projects.$projectId_.services.$serviceId'

const metricsQuery = (serviceId: string, range: MetricWindow) =>
	queryOptions({
		queryKey: ['service', serviceId, 'metrics', range],
		queryFn: () => api.serviceMetrics(serviceId, range),
	})

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/monitoring')({
	loader: ({ context: { queryClient }, params: { serviceId } }) =>
		preload(queryClient, metricsQuery(serviceId, '30m')),
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
const perSecondTick = (value: number) => `${bytesTick(value)}/s`

/**
 * Four charts over one window the reader picks, each with what that window adds up to, then the container facts
 * the strip above does not already carry. Live samples extend the recorded window once a minute while it runs.
 */
function ServiceMonitoring() {
	const { serviceId } = Route.useParams()
	const [range, setRange] = useState<MetricWindow>('30m')
	const [stats, setStats] = useState<Sample | null>(null)
	const [cursor, setCursor] = useState<number | null>(null)
	const [paused, setPaused] = useState(false)
	const span = windows.find(option => option.value === range)?.ms ?? windows[0].ms

	const service = useService(serviceId)
	const recorded = useQuery(metricsQuery(serviceId, range))

	const running = service.data?.state === 'running'
	const stream = useEventSource(
		running ? `/api/services/${serviceId}/stats` : null,
		{ stats: data => setStats({ ...(data as ContainerStats), at: Date.now() }) },
		!paused,
	)
	// Pause closes the stream, so a pause before the first sample has nothing coming.
	let processes: ReactNode = '-'
	if (running && stats) processes = stats.pids
	else if (running && paused) processes = <span className='text-muted'>paused</span>
	else if (running) processes = <PendingReading label='processes' failed={stream === 'lost'} />

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
	// Until the first live sample lands, the newest recorded bucket is the reading; a stopped container has none.
	const newest = stats ?? history.at(-1)
	const current = running ? newest : undefined
	// Wire states: exited, created, paused, restarting, dead, or '' before the first deploy.
	const idle = service.data && !running ? service.data.state || 'not deployed' : undefined
	const blank = idle ? <span className='text-muted'>{idle}</span> : '-'
	const label = windows.find(option => option.value === range)?.label ?? range
	const synced = { cursor, onCursor: setCursor }

	return (
		<Section
			title='Resource usage'
			actions={
				<>
					{/* WCAG 2.2.2: readings that keep moving beside other content can be held still. */}
					{running ? (
						<IconButton
							icon={paused ? IconPlayerPlay : IconPlayerPause}
							label={paused ? 'Resume live readings' : 'Pause live readings'}
							onClick={() => setPaused(!paused)}
						/>
					) : null}
					<Segmented label='Window' value={range} onChange={setRange} options={windows} />
				</>
			}
		>
			<ErrorText error={recorded.error} />
			{history.length === 0 && recorded.isPending ? <ReadingsSkeleton /> : null}
			{history.length === 0 && !recorded.isPending && !recorded.error && idle && service.data ? (
				<NotRunning
					heading='h3'
					service={service.data}
					title={`No readings in the last ${label}`}
					description='The manager records every running service once a minute.'
				/>
			) : null}
			{history.length === 0 && !recorded.isPending && !recorded.error && !idle ? (
				<div className='rounded-surface border bg-surface'>
					<EmptyState
						icon={IconActivity}
						title={`No readings in the last ${label}`}
						description='The manager records every running service once a minute.'
					/>
				</div>
			) : null}
			{history.length > 0 ? (
				<Cells className='grid-cols-1 lg:grid-cols-2'>
					<MetricCard
						label='CPU'
						{...synced}
						icon={IconCpu}
						value={current ? <AnimatedNumber value={current.cpu_percent} format={percent} /> : blank}
						series={{ CPU: cpu }}
						format={percent}
						formatTick={percentTick}
						hint={`avg ${percent(meanOf(cpu))} · peak ${percent(peakOf(cpu))} · 100% is one core`}
						windowLabel={`last ${label}`}
						height={140}
						axis
					/>
					<MetricCard
						label='Memory'
						{...synced}
						icon={IconServer}
						value={current ? <AnimatedNumber value={current.memory_usage} format={bytes} /> : blank}
						series={{ Memory: memory }}
						format={bytes}
						formatTick={bytesTick}
						binary
						hint={`of ${bytes(newest?.memory_limit)} · peak ${bytes(peakOf(memory))}`}
						windowLabel={`last ${label}`}
						height={140}
						axis
					/>
					<MetricCard
						label='Network'
						{...synced}
						icon={IconAffiliate}
						value={
							running ? (
								<>
									<AnimatedNumber value={latest(received)} format={perSecond} />
									{' / '}
									<AnimatedNumber value={latest(sent)} format={perSecond} />
								</>
							) : (
								blank
							)
						}
						series={{ In: received, Out: sent }}
						format={perSecond}
						formatTick={perSecondTick}
						binary
						hint={`in ${bytes(totalOf(history, sample => sample.network_rx))} · out ${bytes(totalOf(history, sample => sample.network_tx))}`}
						windowLabel={`last ${label}`}
						height={140}
						axis
						max={1024}
					/>
					<MetricCard
						label='Block I/O'
						{...synced}
						icon={IconDatabase}
						value={
							running ? (
								<>
									<AnimatedNumber value={latest(read)} format={perSecond} />
									{' / '}
									<AnimatedNumber value={latest(written)} format={perSecond} />
								</>
							) : (
								blank
							)
						}
						series={{ Read: read, Write: written }}
						format={perSecond}
						formatTick={perSecondTick}
						binary
						hint={`read ${bytes(totalOf(history, sample => sample.block_read))} · written ${bytes(totalOf(history, sample => sample.block_write))}`}
						windowLabel={`last ${label}`}
						height={140}
						axis
						max={1024}
					/>
				</Cells>
			) : null}
			{/* State, health, image and deploy time ride in the strip above every tab, so they are not repeated here. */}
			<div className='mt-4 grid items-start gap-x-6 gap-y-4 lg:grid-cols-2'>
				<Facts>
					<Fact label='Container' value={service.data?.container_id?.slice(0, 12) || '-'} />
					<Fact label='Restarts' value={service.data?.restart_count ?? '-'} />
				</Facts>
				<Facts>
					<Fact label='Processes' value={processes} />
					<Fact
						label='Last reading'
						value={newest ? <RelativeTime at={Math.floor(newest.at / 1000)} /> : '-'}
					/>
				</Facts>
			</div>
		</Section>
	)
}

const CHARTS = [
	['CPU', IconCpu],
	['Memory', IconServer],
	['Network', IconAffiliate],
	['Block I/O', IconDatabase],
] as const

/** The four charts' frames while the recorded window loads, so the grid does not jump when it lands. */
function ReadingsSkeleton() {
	return (
		<div>
			<LoadingStatus label='Loading readings' />
			<div aria-hidden>
				<Cells className='grid-cols-1 lg:grid-cols-2'>
					{CHARTS.map(([name, icon]) => (
						<Cell key={name} label={name} icon={icon}>
							<div className='mt-4 h-[218px]'>
								<Skeleton lines={2} />
							</div>
						</Cell>
					))}
				</Cells>
			</div>
		</div>
	)
}
