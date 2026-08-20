import { type PointerEvent, type ReactNode, useEffect, useMemo, useState } from 'react'

/** How much history a chart shows. Matches the default metrics window. */
const WINDOW_MS = 30 * 60 * 1000

/** Cap on buffered live samples, so a tab left open overnight stays bounded. */
const LIVE_LIMIT = 1200

const VIEW_WIDTH = 160
const VIEW_HEIGHT = 32

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
}

/** Compact metric: label, current value, and the recorded window as a sparkline. */
export function MetricCard({ label, value, series, max, format, hint }: MetricCardProps) {
	const ceiling = max ?? Math.max(...series.flatMap(points => points.map(point => point.value)), 0)
	const filled = series.length === 1
	const [primary = []] = series
	const span = rangeOf(series)
	const [hovered, setHovered] = useState<number | null>(null)
	const index = hovered !== null && hovered < primary.length ? hovered : null
	const hoveredAt = index === null ? undefined : primary[index]?.at

	const track = (event: PointerEvent<HTMLDivElement>) => {
		if (!format || primary.length < 2 || span.width <= 0) {
			return
		}
		const { left, width } = event.currentTarget.getBoundingClientRect()
		const time = span.start + ((event.clientX - left) / width) * span.width
		setHovered(nearest(primary, time))
	}

	return (
		// Borderless: the enclosing Cells grid owns the hairlines.
		<div className='px-3 py-2.5'>
			<div className='text-meta tracking-wide text-muted-foreground uppercase'>{label}</div>
			<div className='mt-1 truncate font-mono text-reading tabular-nums'>
				{index === null || !format ? (
					value
				) : (
					<>
						{format(series.map(points => points[index]?.value ?? 0))}
						<span className='text-label text-muted-foreground'>
							{' '}
							{ago(span.end - (hoveredAt ?? span.end))}
						</span>
					</>
				)}
			</div>
			{hint ? <div className='mt-0.5 truncate text-meta text-muted-foreground'>{hint}</div> : null}
			{/* Hover only dates values that are already shown live, so there is
			    nothing here a keyboard user cannot already read. */}
			<div className='mt-1.5' onPointerMove={track} onPointerLeave={() => setHovered(null)}>
				<svg
					viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
					width='100%'
					height={VIEW_HEIGHT}
					preserveAspectRatio='none'
					role='img'
					aria-label={`${label}, last 30 minutes`}
					className='block'
				>
					{series.map((points, position) => (
						<Sparkline
							// Series order is the identity here: the array is rebuilt whole.
							key={position}
							points={points}
							ceiling={ceiling}
							span={span}
							filled={filled}
							muted={position > 0}
							hovered={index}
						/>
					))}
					{index === null || hoveredAt === undefined ? null : (
						<line
							x1={xOf(hoveredAt, span)}
							y1={0}
							x2={xOf(hoveredAt, span)}
							y2={VIEW_HEIGHT}
							stroke='currentColor'
							strokeWidth={1}
							vectorEffect='non-scaling-stroke'
							className='text-border'
						/>
					)}
				</svg>
			</div>
		</div>
	)
}

type Span = { start: number; end: number; width: number }

/** The time range every series in one card shares. */
function rangeOf(series: Point[][]): Span {
	const times = series.flatMap(points => points.map(point => point.at))
	if (times.length === 0) {
		return { start: 0, end: 0, width: 0 }
	}
	const start = Math.min(...times)
	const end = Math.max(...times)
	return { start, end, width: end - start }
}

function xOf(at: number, span: Span) {
	return span.width > 0 ? ((at - span.start) / span.width) * VIEW_WIDTH : VIEW_WIDTH
}

/** Index of the sample closest to `time`; the x axis is time, not sample count. */
function nearest(points: Point[], time: number) {
	let best = 0
	let distance = Number.POSITIVE_INFINITY
	for (const [index, point] of points.entries()) {
		const gap = Math.abs(point.at - time)
		if (gap < distance) {
			best = index
			distance = gap
		}
	}
	return best
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
	return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

type Coordinate = { x: number; y: number }

/**
 * A Catmull-Rom spline through every sample, as SVG cubic segments. Control
 * points are clamped to each segment's own range, so a spike bulges into a
 * curve instead of overshooting past zero or the ceiling.
 */
export function curveThrough(points: Coordinate[]) {
	const [head] = points
	if (!head) {
		return ''
	}
	let path = `M${round(head.x)},${round(head.y)}`
	let before = head
	let start = head

	for (const [index, end] of points.entries()) {
		if (index === 0) {
			continue
		}
		const after = points[index + 1] ?? end
		const low = Math.min(start.y, end.y)
		const high = Math.max(start.y, end.y)
		const first = {
			x: start.x + (end.x - before.x) / 6,
			y: clamp(start.y + (end.y - before.y) / 6, low, high),
		}
		const second = {
			x: end.x - (after.x - start.x) / 6,
			y: clamp(end.y - (after.y - start.y) / 6, low, high),
		}
		path += ` C${round(first.x)},${round(first.y)} ${round(second.x)},${round(second.y)} ${round(end.x)},${round(end.y)}`
		before = start
		start = end
	}

	return path
}

function clamp(value: number, low: number, high: number) {
	return Math.min(Math.max(value, low), high)
}

function round(value: number) {
	return Math.round(value * 10) / 10
}

function Sparkline({
	points,
	ceiling,
	span,
	filled,
	muted,
	hovered,
}: {
	points: Point[]
	ceiling: number
	span: Span
	filled: boolean
	muted: boolean
	hovered: number | null
}) {
	const color = muted ? 'text-muted-foreground' : 'text-foreground'

	// A single sample cannot be a line yet, so the chart rests on its baseline.
	if (points.length < 2) {
		return (
			<line
				x1={0}
				y1={VIEW_HEIGHT - 1}
				x2={VIEW_WIDTH}
				y2={VIEW_HEIGHT - 1}
				stroke='currentColor'
				strokeWidth={1}
				className='text-border'
			/>
		)
	}

	const coordinates = points.map(point => {
		const height = ceiling > 0 ? Math.min(point.value / ceiling, 1) : 0
		return { x: xOf(point.at, span), y: VIEW_HEIGHT - 1 - height * (VIEW_HEIGHT - 2) }
	})
	const path = curveThrough(coordinates)
	const marker = hovered === null ? undefined : coordinates[hovered]

	return (
		<>
			{filled ? (
				<path
					d={`${path} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`}
					fill='currentColor'
					fillOpacity={0.08}
					className={color}
				/>
			) : null}
			<path
				d={path}
				fill='none'
				stroke='currentColor'
				strokeWidth={1.25}
				vectorEffect='non-scaling-stroke'
				className={color}
			/>
			{marker ? <circle cx={marker.x} cy={marker.y} r={1.5} fill='currentColor' className={color} /> : null}
		</>
	)
}
