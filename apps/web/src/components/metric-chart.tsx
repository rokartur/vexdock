import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Cell } from './primitives'

/** How much history a chart shows. Matches the default metrics window. */
const WINDOW_MS = 30 * 60 * 1000

/** Cap on buffered live samples, so a tab left open overnight stays bounded. */
const LIVE_LIMIT = 1200

/** Default sparkline height in px. */
const SPARK_HEIGHT = 32

/** A sample carries its own clock: recorded and live readings arrive at different rates. */
export type Stamped = { at: number }

/** One plotted reading. */
export type Point = { at: number; value: number }

/**
 * Merges recorded history with the live SSE stream. `seed` comes from the
 * metrics endpoint, `sample` is the newest push; both are trimmed to the window,
 * so neither the buffer nor the chart grows without bound.
 */
export function useHistory<TSample extends Stamped>(sample: TSample | null, seed: TSample[] = []) {
	const [live, setLive] = useState<TSample[]>([])

	useEffect(() => {
		if (sample === null) {
			return
		}
		setLive(previous => [...previous, sample].slice(-LIVE_LIMIT))
	}, [sample])

	return useMemo(() => {
		const cutoff = Date.now() - WINDOW_MS
		const liveStart = live.at(0)?.at ?? Number.POSITIVE_INFINITY
		// A recorded bucket that the live stream already covers would draw twice.
		return [
			...seed.filter(point => point.at >= cutoff && point.at < liveStart),
			...live.filter(point => point.at >= cutoff),
		]
	}, [seed, live])
}

/**
 * Per-second deltas of a cumulative counter (network and block i/o report totals
 * since container start, so the raw numbers only ever climb). A container
 * restart resets its counters, which would read as a negative rate; those clamp
 * to zero rather than spiking the chart downwards.
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

/** Turns a stamped history into a plottable series. */
export function seriesOf<TSample extends Stamped>(history: TSample[], value: (sample: TSample) => number): Point[] {
	return history.map(sample => ({ at: sample.at, value: value(sample) }))
}

/** One row of the recharts dataset: a timestamp plus one column per series. */
type Row = { at: number; [series: string]: number }

const columnOf = (index: number) => `s${index}`

/**
 * Series are separate arrays but recharts plots one row set, so they are joined
 * on the timestamp. Series that skip a stamp leave a hole, which `connectNulls`
 * bridges rather than breaking the line.
 */
export function joinSeries(series: Point[][]): Row[] {
	const rows = new Map<number, Row>()
	for (const [index, points] of series.entries()) {
		for (const point of points) {
			const row = rows.get(point.at) ?? { at: point.at }
			row[columnOf(index)] = point.value
			rows.set(point.at, row)
		}
	}
	return [...rows.values()].sort((left, right) => left.at - right.at)
}

type MetricCardProps = {
	label: string
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
}

/** Compact metric: label, current value, and the recorded window as a sparkline. */
export function MetricCard({
	label,
	value,
	series,
	max,
	format,
	hint,
	windowLabel = 'last 30 minutes',
	height = SPARK_HEIGHT,
}: MetricCardProps) {
	const fade = useId()
	const rows = useMemo(() => joinSeries(series), [series])
	const [hovered, setHovered] = useState<number | null>(null)
	const row = hovered === null ? undefined : rows[hovered]
	const filled = series.length === 1

	return (
		<Cell
			label={label}
			hint={hint}
			value={
				row === undefined || !format ? (
					value
				) : (
					<>
						{format(series.map((_, index) => row[columnOf(index)] ?? 0))}
						<span className='text-label text-muted-foreground'>
							{' '}
							{ago((rows.at(-1)?.at ?? row.at) - row.at)}
						</span>
					</>
				)
			}
		>
			{/* Hover only dates values that are already shown live, so there is
			    nothing here a keyboard user cannot already read. */}
			<div className='mt-1.5' style={{ height }} role='img' aria-label={`${label}, ${windowLabel}`}>
				<ResponsiveContainer width='100%' height='100%'>
					<AreaChart
						data={rows}
						margin={{ top: 2, right: 0, bottom: 1, left: 0 }}
						onMouseMove={state => setHovered(indexOf(state.activeTooltipIndex))}
						onMouseLeave={() => setHovered(null)}
					>
						<defs>
							<linearGradient id={fade} x1='0' y1='0' x2='0' y2='1'>
								<stop offset='0%' stopColor='var(--primary)' stopOpacity={0.3} />
								<stop offset='100%' stopColor='var(--primary)' stopOpacity={0} />
							</linearGradient>
						</defs>
						<XAxis dataKey='at' type='number' domain={['dataMin', 'dataMax']} hide />
						<YAxis type='number' domain={[0, max ?? 'dataMax']} hide />
						<Tooltip content={noTooltip} cursor={{ stroke: 'var(--border)', strokeWidth: 1 }} />
						{series.map((_, index) => {
							// The lead series draws in the brand orange, the way datafa.st charts do.
							const color = index > 0 ? 'var(--muted-foreground)' : 'var(--primary)'
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

/** The card already shows the hovered reading in its value line; the cursor is enough. */
const noTooltip = () => null

/**
 * Recharts stringifies the active index (`String(clampedIndex)`), even on the
 * numerically indexed charts, so reading it as a number gives back nothing.
 */
export function indexOf(active?: number | string | null) {
	const index = Number(active ?? Number.NaN)
	return Number.isInteger(index) ? index : null
}

function ago(milliseconds: number) {
	const seconds = Math.round(milliseconds / 1000)
	if (seconds <= 1) {
		return 'now'
	}
	if (seconds < 60) {
		return `${seconds}s ago`
	}
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) {
		return `${minutes}m ago`
	}
	const hours = Math.round(minutes / 60)
	return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}
