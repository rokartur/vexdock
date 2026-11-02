import { useId, useState } from 'react'
import { cn } from 'cn'
import { motion, useReducedMotion } from 'motion/react'
import type { HostPoint, MetricWindow } from '../lib/api'
import { bytes, percent } from '../lib/format'
import { motionTokens } from '../lib/motion'
import { AnimatedNumber } from './animated-number'
import { HistoryChart, seriesOf } from './metric-chart'
import { Segmented } from './primitives'

export const WINDOWS = [
	{ value: '30m', label: '30m', long: 'last 30 minutes', ms: 30 * 60 * 1000 },
	{ value: '1h', label: '1h', long: 'last hour', ms: 60 * 60 * 1000 },
	{ value: '6h', label: '6h', long: 'last 6 hours', ms: 6 * 60 * 60 * 1000 },
	{ value: '24h', label: '24h', long: 'last 24 hours', ms: 24 * 60 * 60 * 1000 },
	{ value: '7d', label: '7d', long: 'last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
] as const satisfies readonly { value: MetricWindow; label: string; long: string; ms: number }[]

const METRICS = [
	{
		key: 'cpu',
		label: 'CPU',
		read: (point: HostPoint) => point.cpu_percent,
		format: percent,
		max: () => 100,
		of: (_point: HostPoint, load?: number) => (load === undefined ? 'of all cores' : `load ${load.toFixed(2)}`),
	},
	{
		key: 'memory',
		label: 'Memory',
		read: (point: HostPoint) => point.memory_used,
		format: bytes,
		max: (point: HostPoint) => point.memory_total,
		of: (point: HostPoint) => `of ${bytes(point.memory_total)}`,
	},
	{
		key: 'disk',
		label: 'Disk',
		read: (point: HostPoint) => point.disk_used,
		format: bytes,
		max: (point: HostPoint) => point.disk_total,
		of: (point: HostPoint) => `of ${bytes(point.disk_total)}`,
	},
] as const

/** Arc's metrics-dashboard: a tab per host reading, one chart for the picked one, and the window it covers. */
export function HostMetrics({
	history,
	window,
	onWindowChange,
	load,
}: {
	history: HostPoint[]
	/** Only the live stream carries it, so it is missing until the first push. */
	load?: number
	window: MetricWindow
	onWindowChange: (window: MetricWindow) => void
}) {
	const id = useId()
	const reduced = useReducedMotion()
	const [metricKey, setMetricKey] = useState<(typeof METRICS)[number]['key']>('cpu')
	const metric = METRICS.find(option => option.key === metricKey) ?? METRICS[0]
	const range = WINDOWS.find(option => option.value === window) ?? WINDOWS[0]
	const current = history.at(-1)

	return (
		<section className='mb-8 min-w-0 shrink-0 overflow-hidden rounded-surface border bg-surface'>
			<header className='flex flex-wrap items-center justify-between gap-3 px-5 py-4'>
				<div className='min-w-0'>
					<h2 className='text-base/[1.1] font-medium'>Host</h2>
					<p className='mt-0.5 text-sm text-muted'>{range.long}</p>
				</div>
				<Segmented label='Window' value={window} options={WINDOWS} onChange={onWindowChange} />
			</header>

			<div role='tablist' aria-label='Metric' className='grid grid-cols-3 border-y'>
				{METRICS.map(option => {
					const selected = option.key === metricKey
					return (
						<button
							key={option.key}
							type='button'
							role='tab'
							aria-selected={selected}
							onClick={() => setMetricKey(option.key)}
							className='relative grid min-w-0 gap-0.5 px-4 py-3.5 text-left transition-colors not-first:border-l hover:bg-surface-muted sm:pl-5'
						>
							{selected ? (
								<motion.span
									layoutId={`${id}-metric`}
									transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}
									className='absolute inset-x-0 -bottom-px z-1 h-0.5 bg-accent'
								/>
							) : null}
							<span className={cn('truncate text-sm text-secondary', selected && 'text-foreground')}>
								{option.label}
							</span>
							<span className='text-lg/[1.3] font-medium whitespace-nowrap tabular-nums sm:text-xl/[1.3]'>
								{current ? <AnimatedNumber value={option.read(current)} format={option.format} /> : '-'}
							</span>
							<span className='truncate text-xs text-muted'>
								{current ? option.of(current, load) : ''}
							</span>
						</button>
					)
				})}
			</div>

			<div className='px-3 pt-4 pb-3 sm:px-5'>
				<HistoryChart
					label={`${metric.label}, ${range.long}`}
					height={160}
					series={{ [metric.label]: seriesOf(history, metric.read) }}
					format={metric.format}
					max={current ? metric.max(current) : undefined}
				/>
			</div>
		</section>
	)
}
