import { IconCpu, IconDeviceSdCard, IconServer } from '@tabler/icons-react'
import type { HostStats } from '../lib/api'
import { bytes, percent } from '../lib/format'
import { AnimatedNumber } from './animated-number'
import { PendingReading, StatStrip } from './primitives'

/** The dashboard's live host readings: CPU, memory and disk side by side. */
export function HostMetrics({
	stats,
	cpus,
	failed,
}: {
	/** Missing until the stream's first push. */
	stats: HostStats | null
	cpus?: number
	/** No reading to show and none coming: the stream is lost. */
	failed: boolean
}) {
	const cores = cpus ? `${cpus} ${cpus === 1 ? 'core' : 'cores'}` : 'of all cores'
	return (
		<StatStrip
			className='mb-8'
			items={[
				{
					label: 'CPU',
					icon: IconCpu,
					value: stats ? (
						<AnimatedNumber value={stats.cpu_percent} format={percent} />
					) : (
						<PendingReading label='CPU' failed={failed} />
					),
					hint: stats ? `load ${stats.load_average.toFixed(2)} · ${cores}` : cores,
				},
				{
					label: 'Memory',
					icon: IconServer,
					value: stats ? (
						<AnimatedNumber value={stats.memory_used} format={bytes} />
					) : (
						<PendingReading label='memory' failed={failed} />
					),
					hint: stats ? `of ${bytes(stats.memory_total)}` : undefined,
				},
				{
					label: 'Disk',
					icon: IconDeviceSdCard,
					value: stats ? (
						<AnimatedNumber value={stats.disk_used} format={bytes} />
					) : (
						<PendingReading label='disk' failed={failed} />
					),
					hint: stats ? `of ${bytes(stats.disk_total)}` : undefined,
				},
			]}
		/>
	)
}
