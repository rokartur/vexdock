import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { Icon as TablerIcon } from '@tabler/icons-react'
import { cn } from 'cn'
import { Cell } from './primitives'
import { LineChart } from './ui/line-chart'
import { Sparkline } from './ui/sparkline'

/** How much history a chart shows unless told otherwise. Matches the default metrics window. */
const WINDOW_MS = 30 * 60 * 1000

/** Past this span a tick names the day as well as the hour, or two ticks a day apart would read the same. */
const DAY_MS = 24 * 60 * 60 * 1000

/** Cap on buffered live samples, so a tab left open overnight stays bounded. */
const LIVE_LIMIT = 1200

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

/** Turns a stamped history into a plottable series. */
export function seriesOf<TSample extends Stamped>(history: TSample[], value: (sample: TSample) => number): Point[] {
	return history.map(sample => ({ at: sample.at, value: value(sample) }))
}

type MetricCardProps = {
	label: string
	icon?: TablerIcon
	/** Current reading, rendered as text so the chart never has to be precise. */
	value: ReactNode
	/** Named series over the same samples; a second one (out, write) draws beside the first. */
	series: Record<string, Point[]>
	/** One reading, for the hover readout and the axis ticks. */
	format: (value: number) => string
	/** What the reading is measured against: a total, a load average, a peak. */
	hint?: ReactNode
	/** How much history the series covers, for the chart's accessible name. */
	windowLabel?: string
	/** Drawn height in px. */
	height?: number
	/** The chart beside the reading instead of under it, for a card wide enough to spare the row. */
	inline?: boolean
	/** Arc's line chart with axes and a legend, for a chart tall enough to read a level off; without it, Arc's sparkline. */
	axis?: boolean
	/** Lowest ceiling for the scale, from zero: 100 for a percent, the total for memory, 1024 for an idle byte rate. */
	max?: number
	cursor?: number | null
	onCursor?: (at: number | null) => void
}

/** Compact metric: label, current reading, and the recorded window as Arc's line chart or sparkline. */
export function MetricCard({
	label,
	icon,
	value,
	series,
	format,
	hint,
	windowLabel = 'last 30 minutes',
	height = 32,
	inline = false,
	axis = false,
	max,
	cursor,
	onCursor,
}: MetricCardProps) {
	const samples = Object.values(series)[0] ?? []
	const name = `${label}, ${windowLabel}`

	return (
		<Cell label={label} icon={icon} hint={hint} value={value} inline={inline}>
			<div className={cn('min-w-0 flex-1', !inline && 'mt-3')}>
				{axis ? (
					<HistoryChart
						label={name}
						height={height}
						series={series}
						format={format}
						max={max}
						cursor={cursor}
						onCursor={onCursor}
					/>
				) : (
					<Sparkline
						label={name}
						data={samples.map(sample => sample.value)}
						height={height}
						width={320}
						interactive={false}
						caption={false}
						max={max}
					/>
				)}
			</div>
		</Cell>
	)
}

/** Arc's line chart with axes over named series that share their samples' clock. */
export function HistoryChart({
	label,
	series,
	format,
	height,
	max,
	cursor,
	onCursor,
}: {
	label: string
	series: Record<string, Point[]>
	format: (value: number) => string
	height: number
	max?: number
	/** Hovered moment in ms, shared across charts; rate series run one sample short, so the clock lines them up, not the index. */
	cursor?: number | null
	onCursor?: (at: number | null) => void
}) {
	const names = Object.keys(series)
	const samples = series[names[0] ?? ''] ?? []
	const span = (samples.at(-1)?.at ?? 0) - (samples[0]?.at ?? 0)
	let activeIndex: number | null | undefined
	if (cursor !== undefined) {
		const found = cursor === null ? -1 : samples.findIndex(sample => sample.at >= cursor)
		activeIndex = found === -1 ? null : found
	}
	return (
		<LineChart
			activeIndex={activeIndex}
			onActiveChange={index => onCursor?.(index === null ? null : (samples[index]?.at ?? null))}
			label={label}
			height={height}
			categoryLabel='Time'
			max={max}
			formatValue={format}
			formatTick={format}
			series={names.map(key => ({ key, label: key, area: names.length === 1 }))}
			data={samples.map((sample, index) => ({
				key: String(sample.at),
				label: (span > DAY_MS ? dayStamp : clockStamp)(sample.at),
				axisLabel: (span > DAY_MS ? dayStamp : hourStamp)(sample.at),
				values: Object.fromEntries(names.map(key => [key, series[key]?.[index]?.value])),
			}))}
		/>
	)
}

const hourStamp = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const clockStamp = (at: number) => new Date(at).toLocaleTimeString()
const dayStamp = (at: number) =>
	new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
