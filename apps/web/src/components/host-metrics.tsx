import { IconCpu, IconDeviceSdCard, IconServer } from '@tabler/icons-react'
import type { HostPoint, MetricWindow } from '../lib/api'
import { bytes, percent } from '../lib/format'
import { AnimatedNumber } from './animated-number'
import { MetricCard, seriesOf } from './metric-chart'
import { Cells, PendingReading } from './primitives'

export const WINDOWS = [
	{ value: '30m', label: '30m', long: 'last 30 minutes', ms: 30 * 60 * 1000 },
	{ value: '1h', label: '1h', long: 'last hour', ms: 60 * 60 * 1000 },
	{ value: '6h', label: '6h', long: 'last 6 hours', ms: 6 * 60 * 60 * 1000 },
	{ value: '24h', label: '24h', long: 'last 24 hours', ms: 24 * 60 * 60 * 1000 },
	{ value: '7d', label: '7d', long: 'last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
] as const satisfies readonly { value: MetricWindow; label: string; long: string; ms: number }[]

/** The dashboard's host readings: CPU, memory and disk side by side, each with its window as a sparkline. */
export function HostMetrics({
	history,
	window,
	load,
	cpus,
	failed,
}: {
	history: HostPoint[]
	window: MetricWindow
	/** Only the live stream carries it, so it is missing until the first push. */
	load?: number
	cpus?: number
	/** No reading to show and none coming: the history failed or the stream is lost. */
	failed: boolean
}) {
	const range = WINDOWS.find(option => option.value === window) ?? WINDOWS[0]
	const current = history.at(-1)
	const cores = cpus ? `${cpus} ${cpus === 1 ? 'core' : 'cores'}` : 'of all cores'

	return (
		// Sized off its own width: at 768 the rail leaves the page too little for three readings side by side.
		<div className='@container mb-8'>
			<Cells className='grid-cols-1 @xl:grid-cols-3'>
				<MetricCard
					label='CPU'
					icon={IconCpu}
					value={
						current ? (
							<AnimatedNumber value={current.cpu_percent} format={percent} />
						) : (
							<PendingReading label='CPU' failed={failed} />
						)
					}
					hint={load === undefined ? cores : `load ${load.toFixed(2)} · ${cores}`}
					series={{ CPU: seriesOf(history, point => point.cpu_percent) }}
					format={percent}
					max={100}
					windowLabel={range.long}
					height={48}
					inline
				/>
				<MetricCard
					label='Memory'
					icon={IconServer}
					value={
						current ? (
							<AnimatedNumber value={current.memory_used} format={bytes} />
						) : (
							<PendingReading label='memory' failed={failed} />
						)
					}
					hint={current ? `of ${bytes(current.memory_total)}` : undefined}
					series={{ Memory: seriesOf(history, point => point.memory_used) }}
					format={bytes}
					max={current?.memory_total}
					windowLabel={range.long}
					height={48}
					inline
				/>
				<MetricCard
					label='Disk'
					icon={IconDeviceSdCard}
					value={
						current ? (
							<AnimatedNumber value={current.disk_used} format={bytes} />
						) : (
							<PendingReading label='disk' failed={failed} />
						)
					}
					hint={current ? `of ${bytes(current.disk_total)}` : undefined}
					series={{ Disk: seriesOf(history, point => point.disk_used) }}
					format={bytes}
					max={current?.disk_total}
					windowLabel={range.long}
					height={48}
					inline
				/>
			</Cells>
		</div>
	)
}
