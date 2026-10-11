import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { Icon as TablerIcon } from '@tabler/icons-react'
import { cn } from '@/utils/cn'
import { Cell } from './primitives'

/** How much history a chart shows unless told otherwise. Matches the default metrics window. */
const WINDOW_MS = 30 * 60 * 1000

/** Past this span a tick names the day as well as the hour, or two ticks a day apart would read the same. */
const DAY_MS = 24 * 60 * 60 * 1000

/** Cap on buffered live samples, so a tab left open overnight stays bounded. */
const LIVE_LIMIT = 1200

/** Default sparkline height in px. */
const SPARK_HEIGHT = 32

/** A sample carries its own clock: recorded and live readings arrive at different rates. */
export type Stamped = { at: number }

/** One plotted reading. */
export type Point = { at: number; value: number }

/** `seed` is recorded history, `sample` the newest SSE push. Both are trimmed to the window so neither grows. */
export function useHistory<TSample extends Stamped>(
	sample: TSample | null,
	seed: TSample[] = [],
	windowMs = WINDOW_MS,
) {
	const [live, setLive] = useState<TSample[]>([])

	useEffect(() => {
		if (sample === null) {
			return
		}
		setLive(previous => [...previous, sample].slice(-LIVE_LIMIT))
	}, [sample])

	return useMemo(() => {
		const cutoff = Date.now() - windowMs
		const liveStart = live.at(0)?.at ?? Number.POSITIVE_INFINITY
		// A recorded bucket that the live stream already covers would draw twice.
		return [
			...seed.filter(point => point.at >= cutoff && point.at < liveStart),
			...live.filter(point => point.at >= cutoff),
		]
	}, [seed, live, windowMs])
}

/**
 * Per-second deltas of a counter that only climbs (network and block i/o are totals since container start).
 * A restart resets the counter, so the negative rate that follows clamps to zero instead of spiking downwards.
 */
export function ratesOf<TSample extends Stamped>(history: TSample[], total: (sample: TSample) => number): Point[] {
	const rates: Point[] = []
	let previous: TSample | null = null

	for (const sample of history) {
		if (previous !== null) {
			const elapsed = (sample.at - previous.at) / 1000
			const delta = total(sample) - total(previous)
			rates.push({ at: sample.at, value: elapsed > 0 ? Math.max(delta / elapsed, 0) : 0 })
		}
		previous = sample
	}

	return rates
}

/**
 * How much a climbing counter moved across the history. A counter that drops has restarted from zero with its
 * container, so what it reads after the drop is all new, not a negative step.
 */
export function totalOf<TSample extends Stamped>(history: TSample[], total: (sample: TSample) => number): number {
	let sum = 0
	for (const [index, sample] of history.entries()) {
		const previous = history[index - 1]
		if (previous === undefined) continue
		const delta = total(sample) - total(previous)
		sum += delta >= 0 ? delta : total(sample)
	}
	return sum
}

/**
 * The first round number at or above `value`, as 1, 2 or 5 of a power of ten, so an axis reads 0, 50, 100 and not
 * 0, 43.7, 87.4. `base` 1024 does the same inside each byte unit, so the ticks come out as 500 KB, not 488.3 KB.
 */
export function niceCeil(value: number, base: 10 | 1024 = 10): number {
	if (!(value > 0)) return 1
	const unit = base === 1024 ? 1024 ** Math.max(Math.floor(Math.log(value) / Math.log(1024)), 0) : 1
	const scaled = value / unit
	const power = 10 ** Math.floor(Math.log10(scaled))
	const step = [1, 2, 5, 10].find(candidate => candidate * power >= scaled) ?? 10
	return step * power * unit
}

/** The highest reading across every series, zero for none. */
function peakOf(series: Point[][]): number {
	let peak = 0
	for (const points of series) {
		for (const point of points) peak = Math.max(peak, point.value)
	}
	return peak
}

/** Turns a stamped history into a plottable series. */
export function seriesOf<TSample extends Stamped>(history: TSample[], value: (sample: TSample) => number): Point[] {
	return history.map(sample => ({ at: sample.at, value: value(sample) }))
}

/** Half a stroke of headroom, so a reading at the floor or the ceiling is not clipped by its own line width. */
const SPARK_INSET = 1

/**
 * An SVG polyline through `values`, left to right, oldest first. `max` is the
 * ceiling to scale against; without one the window's own peak is the ceiling,
 * which reads shape rather than level. Empty for nothing to draw.
 */
export function sparkPath(values: number[], width: number, height: number, max?: number): string {
	if (values.length === 0) {
		return ''
	}
	const peak = max ?? Math.max(...values)
	const span = height - 2 * SPARK_INSET
	const y = (value: number) =>
		peak > 0 ? height - SPARK_INSET - Math.min(Math.max(value / peak, 0), 1) * span : height - SPARK_INSET
	// A single reading has no run to spread over, so it draws as the flat line it is.
	if (values.length === 1) {
		return `M0,${y(values[0] ?? 0)} L${width},${y(values[0] ?? 0)}`
	}
	const step = width / (values.length - 1)
	return values.map((value, index) => `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(1)},${y(value)}`).join(' ')
}

/** A run of readings at row height: shape only, no axis, no tooltip. What a table cell has room for. */
export function Sparkline({
	values,
	max,
	label,
	width = 56,
	height = 16,
}: {
	values: number[]
	max?: number
	/** What the run is of, for anyone not reading the picture. */
	label: string
	width?: number
	height?: number
}) {
	const path = sparkPath(values, width, height, max)
	if (!path) {
		return <span className='text-muted-foreground'>-</span>
	}
	return (
		<svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role='img' aria-label={label}>
			<path d={path} fill='none' stroke='var(--accent)' strokeWidth={1} vectorEffect='non-scaling-stroke' />
		</svg>
	)
}

/** The reading closest in time to `at`, for the point under the pointer. */
export function nearestTo(points: Point[], at: number): Point | undefined {
	let nearest: Point | undefined
	for (const point of points) {
		if (nearest === undefined || Math.abs(point.at - at) < Math.abs(nearest.at - at)) nearest = point
	}
	return nearest
}

/** Plot width in SVG units. The SVG stretches to its box, so only proportions matter. */
const PLOT_WIDTH = 1000

/** The first series is the reading, a second one (tx, write) draws quieter beside it. */
const seriesColors = ['var(--accent)', 'var(--text-muted)']

function spanOf(series: Point[][]) {
	let start = Number.POSITIVE_INFINITY
	let end = Number.NEGATIVE_INFINITY
	for (const points of series) {
		for (const point of points) {
			start = Math.min(start, point.at)
			end = Math.max(end, point.at)
		}
	}
	return { start, end }
}

type MetricCardProps = {
	label: string
	icon?: TablerIcon
	/** Current reading, rendered as text so the chart never has to be precise. */
	value: ReactNode
	/** One series draws filled; a second one draws muted on top (rx/tx, read/write). */
	series: Point[][]
	/** Fixed upper bound, e.g. 100 for a percentage. Omit to scale to the window. */
	max?: number
	/** Renders one sample per series while hovering. Without it the chart is inert. */
	format?: (values: number[]) => string
	/** What the reading is measured against: a total, a load average, a peak. */
	hint?: ReactNode
	/** How much history the series covers, for the chart's accessible name. */
	windowLabel?: string
	/** Drawn height in px. The default is the sparkline; the dashboard goes big. */
	height?: number
	/** The chart beside the reading instead of under it, for a card wide enough to spare the row. */
	inline?: boolean
	/**
	 * Draws the axes, for a chart tall enough to read a level off. The top of the scale is the window's peak rounded
	 * up, never below `floor`, so an idle service does not blow its noise up to full height. Ignored with `max`.
	 */
	axis?: { tick: (value: number) => string; floor?: number; base?: 10 | 1024 }
}

/** Compact metric: label, current value, and the recorded window drawn the way Arc's line chart draws it. */
export function MetricCard({
	label,
	icon,
	value,
	series,
	max,
	format,
	hint,
	windowLabel = 'last 30 minutes',
	height = SPARK_HEIGHT,
	inline = false,
	axis,
}: MetricCardProps) {
	const [hoverAt, setHoverAt] = useState<number | null>(null)
	const { start, end } = spanOf(series)
	const span = end - start
	// Worked out here so the three ticks split the scale evenly.
	const top = max ?? (axis ? niceCeil(Math.max(peakOf(series), axis.floor ?? 0), axis.base) : peakOf(series))
	const ticks = [0, top / 2, top]
	const x = (at: number) => (span > 0 ? ((at - start) / span) * PLOT_WIDTH : 0)
	const y = (reading: number) =>
		top > 0
			? height - SPARK_INSET - Math.min(Math.max(reading / top, 0), 1) * (height - 2 * SPARK_INSET)
			: height - SPARK_INSET
	const percentOf = (at: number) => `${(x(at) / PLOT_WIDTH) * 100}%`
	const hovered = hoverAt === null ? [] : series.map(points => nearestTo(points, hoverAt))
	const anchor = hovered[0] ?? hovered[1]

	const plot = (
		<div
			className='relative min-w-0 touch-pan-y select-none'
			style={{ height }}
			onPointerMove={
				format &&
				(event => {
					const box = event.currentTarget.getBoundingClientRect()
					const fraction = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1)
					setHoverAt(start + fraction * span)
				})
			}
			onPointerLeave={() => setHoverAt(null)}
		>
			<svg
				className='absolute inset-0 size-full overflow-visible'
				viewBox={`0 0 ${PLOT_WIDTH} ${height}`}
				preserveAspectRatio='none'
				aria-hidden
			>
				{axis
					? ticks.map(tick => (
							<line
								key={tick}
								x1={0}
								x2={PLOT_WIDTH}
								y1={y(tick)}
								y2={y(tick)}
								stroke={tick === 0 ? 'var(--border-strong)' : 'var(--border)'}
								vectorEffect='non-scaling-stroke'
								shapeRendering='crispEdges'
							/>
						))
					: null}
				{series.map((points, index) => {
					const line = linePath(points, x, y)
					if (!line) return null
					const color = seriesColors[index] ?? seriesColors[1]
					const first = points[0]?.at ?? start
					const last = points.at(-1)?.at ?? end
					return (
						// Series order is the identity here: the array is rebuilt whole.
						<g key={index}>
							{series.length === 1 ? (
								<path
									d={`${line} L${points.length > 1 ? x(last) : PLOT_WIDTH},${height} L${x(first)},${height} Z`}
									fill={`color-mix(in oklab, ${color} 9%, transparent)`}
								/>
							) : null}
							<path
								d={line}
								fill='none'
								stroke={color}
								strokeWidth={2}
								strokeLinecap='round'
								strokeLinejoin='round'
								vectorEffect='non-scaling-stroke'
							/>
						</g>
					)
				})}
			</svg>
			{anchor && format ? (
				<>
					<span
						className='pointer-events-none absolute inset-y-0 w-px bg-(--border-strong)'
						style={{ left: percentOf(anchor.at) }}
					/>
					{hovered.map((point, index) =>
						point ? (
							<span
								key={index}
								className='pointer-events-none absolute size-2.5 -translate-1/2 rounded-full border-2 border-(--surface)'
								style={{
									left: percentOf(point.at),
									top: y(point.value),
									background: seriesColors[index],
								}}
							/>
						) : null,
					)}
					<div
						className='pointer-events-none absolute top-0 z-10 grid gap-1 rounded-[14px] border bg-(--surface-raised) px-3 py-2.5 whitespace-nowrap shadow-(--shadow-floating)'
						style={{
							left: percentOf(anchor.at),
							translate: x(anchor.at) > PLOT_WIDTH / 2 ? 'calc(-100% - 12px) 0' : '12px 0',
						}}
					>
						<span className='text-xs text-(--text-secondary)'>
							{(span > DAY_MS ? dayStamp : clockStamp)(anchor.at)}
						</span>
						<span className='text-sm font-medium'>{format(hovered.map(point => point?.value ?? 0))}</span>
					</div>
				</>
			) : null}
		</div>
	)

	return (
		<Cell label={label} icon={icon} hint={hint} value={value} inline={inline}>
			<div
				className={cn(
					!inline && 'mt-3',
					axis && 'grid grid-cols-[minmax(0,1fr)_48px] grid-rows-[auto_26px] text-xs text-muted-foreground',
				)}
				role='img'
				aria-label={`${label}, ${windowLabel}`}
			>
				{plot}
				{axis ? (
					<>
						<div className='relative'>
							{ticks.map(tick => (
								<span
									key={tick}
									className='absolute left-2.5 -translate-y-1/2 leading-none whitespace-nowrap'
									style={{ top: y(tick) }}
								>
									{axis.tick(tick)}
								</span>
							))}
						</div>
						<div className='relative'>
							{span > 0
								? [0, 0.5, 1].map(fraction => (
										<span
											key={fraction}
											className='absolute top-2 leading-none whitespace-nowrap'
											style={{ left: `${fraction * 100}%`, translate: `${-fraction * 100}% 0` }}
										>
											{(span > DAY_MS ? dayStamp : hourStamp)(start + fraction * span)}
										</span>
									))
								: null}
						</div>
					</>
				) : null}
			</div>
		</Cell>
	)
}

/** A polyline through one series, oldest first. A single reading draws as the flat line it is. */
function linePath(points: Point[], x: (at: number) => number, y: (reading: number) => number): string {
	const [first] = points
	if (first === undefined) return ''
	if (points.length === 1) return `M0,${y(first.value)} L${PLOT_WIDTH},${y(first.value)}`
	return points
		.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.at).toFixed(1)},${y(point.value)}`)
		.join(' ')
}

const hourStamp = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const clockStamp = (at: number) => new Date(at).toLocaleTimeString()
const dayStamp = (at: number) =>
	new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
