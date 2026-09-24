import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import type { Icon as TablerIcon } from '@tabler/icons-react'
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	type TooltipContentProps,
	XAxis,
	YAxis,
} from 'recharts'
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
			<path d={path} fill='none' stroke='var(--chart-1)' strokeWidth={1} vectorEffect='non-scaling-stroke' />
		</svg>
	)
}

/** One row of the recharts dataset: a timestamp plus one column per series. */
type Row = { at: number; [series: string]: number }

const columnOf = (index: number) => `s${index}`

/** Recharts plots one row set, so series are joined on the timestamp. A skipped stamp is a hole for `connectNulls`. */
export function joinSeries(series: Point[][]): Row[] {
	const rows = new Map<number, Row>()
	for (const [index, points] of series.entries()) {
		for (const point of points) {
			const row = rows.get(point.at) ?? { at: point.at }
			row[columnOf(index)] = point.value
			rows.set(point.at, row)
		}
	}
	return [...rows.values()].toSorted((left, right) => left.at - right.at)
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

/** Compact metric: label, current value, and the recorded window as a sparkline. */
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
	const fade = useId()
	const rows = useMemo(() => joinSeries(series), [series])
	const filled = series.length === 1
	const span = (rows.at(-1)?.at ?? 0) - (rows.at(0)?.at ?? 0)
	const stamp = span > DAY_MS ? dayStamp : hourStamp
	// The scale is worked out here rather than left to recharts, so the three ticks split it evenly.
	const top = max ?? (axis ? niceCeil(Math.max(peakOf(series), axis.floor ?? 0), axis.base) : undefined)
	const tick = { fontSize: 11, fill: 'var(--muted-foreground)' }

	return (
		<Cell label={label} icon={icon} hint={hint} value={value} inline={inline}>
			{/* The tooltip only dates values that are already shown live, so the chart's own
			    focusable accessibility layer buys nothing and only draws a focus ring. */}
			<div
				className={inline ? undefined : 'mt-1.5'}
				style={{ height }}
				role='img'
				aria-label={`${label}, ${windowLabel}`}
			>
				<ResponsiveContainer width='100%' height='100%'>
					<AreaChart data={rows} margin={{ top: 2, right: 0, bottom: 1, left: 0 }} accessibilityLayer={false}>
						<defs>
							<linearGradient id={fade} x1='0' y1='0' x2='0' y2='1'>
								<stop offset='0%' stopColor='var(--chart-1)' stopOpacity={0.3} />
								<stop offset='100%' stopColor='var(--chart-1)' stopOpacity={0} />
							</linearGradient>
						</defs>
						{axis ? <CartesianGrid vertical={false} stroke='var(--border)' strokeDasharray='2 4' /> : null}
						<XAxis
							dataKey='at'
							type='number'
							domain={['dataMin', 'dataMax']}
							hide={!axis}
							tickFormatter={stamp}
							tick={tick}
							tickLine={false}
							axisLine={false}
							minTickGap={48}
						/>
						<YAxis
							type='number'
							domain={[0, top ?? 'dataMax']}
							ticks={axis && top !== undefined ? [0, top / 2, top] : undefined}
							hide={!axis}
							tickFormatter={axis?.tick}
							tick={tick}
							tickLine={false}
							axisLine={false}
							width={64}
						/>
						<Tooltip
							content={
								<MetricTooltip
									count={series.length}
									format={format}
									stamp={span > DAY_MS ? dayStamp : clockStamp}
								/>
							}
							cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
							// Kept inside the chart box on purpose: the cells grid clips its
							// overflow, so a tooltip that escaped would be cut at the edge.
							allowEscapeViewBox={{ x: false, y: false }}
							isAnimationActive={false}
						/>
						{series.map((_, index) => {
							const color = index > 0 ? 'var(--muted-foreground)' : 'var(--chart-1)'
							return (
								<Area
									// Series order is the identity here: the array is rebuilt whole.
									key={index}
									dataKey={columnOf(index)}
									type='monotone'
									stroke={color}
									strokeWidth={1.5}
									fill={filled ? `url(#${fade})` : 'none'}
									dot={false}
									activeDot={{ r: 1.5, fill: color, stroke: 'none' }}
									connectNulls
									isAnimationActive={false}
								/>
							)
						})}
					</AreaChart>
				</ResponsiveContainer>
			</div>
		</Cell>
	)
}

const hourStamp = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const clockStamp = (at: number) => new Date(at).toLocaleTimeString()
const dayStamp = (at: number) =>
	new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/**
 * The reading under the cursor: when it was taken, and what it was. Recharts
 * clones this element with the hover state, so `format` rides along as a prop.
 */
function MetricTooltip({
	active,
	label,
	payload,
	count,
	format,
	stamp,
}: Partial<TooltipContentProps<number, string>> & {
	count: number
	format?: MetricCardProps['format']
	stamp: (at: number) => string
}) {
	if (!(active && payload?.length && format)) {
		return null
	}
	// Read by key, not by position: recharts drops null entries from the payload,
	// which would slide a two-series card's values apart wherever one has a gap.
	const values = Array.from({ length: count }, (_, index) =>
		Number(payload.find(entry => entry.dataKey === columnOf(index))?.value ?? 0),
	)
	return (
		<div className='rounded-md border border-border bg-popover px-2 py-1 text-meta'>
			<span className='text-muted-foreground'>{stamp(Number(label))}</span> {format(values)}
		</div>
	)
}
