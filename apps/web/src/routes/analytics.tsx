import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { curveThrough, MetricCard, type Point } from '../components/metric-chart'
import { Button, Cell, Cells, ErrorText, Page, Refresh, Section, Segmented } from '../components/primitives'
import { type AnalyticsRange, api, type Breakdown, type Traffic, type TrafficPoint } from '../lib/api'
import { delta, dense, WEEKDAYS, weekdayHours } from '../lib/traffic'

const ranges: { value: AnalyticsRange; label: string }[] = [
	{ value: '24h', label: '24h' },
	{ value: '7d', label: '7d' },
	{ value: '30d', label: '30d' },
]

export const Route = createFileRoute('/analytics')({ component: AnalyticsPage })

function AnalyticsPage() {
	const [hostname, setHostname] = useState<string | null>(null)
	const [range, setRange] = useState<AnalyticsRange>('24h')

	const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
	const tracked = domains.data?.filter(domain => domain.analytics) ?? []
	const selected = tracked.find(domain => domain.hostname === hostname)?.hostname ?? tracked[0]?.hostname

	const analytics = useQuery({
		queryKey: ['analytics', selected, range],
		queryFn: () => api.analytics(selected as string, range),
		enabled: Boolean(selected),
		// Online drops as soon as a visitor leaves, so keep the page close to live.
		refetchInterval: 30_000,
	})
	const traffic = analytics.data?.traffic
	const windowLabel = `last ${ranges.find(option => option.value === range)?.label}`
	// Four weeks of history that no range changes, so it outlives the 30s poll.
	const activity = useQuery({
		queryKey: ['analytics-activity', selected],
		queryFn: () => api.analyticsActivity(selected as string),
		enabled: Boolean(selected),
		staleTime: 5 * 60_000,
	})
	const queryClient = useQueryClient()
	const [confirmClear, setConfirmClear] = useState(false)
	const clear = useMutation({
		mutationFn: () => api.clearAnalytics(selected as string),
		onSuccess: () => {
			setConfirmClear(false)
			return queryClient.invalidateQueries({ queryKey: ['analytics'] })
		},
	})

	if (!(domains.isLoading || tracked.length)) {
		return (
			<Page>
				<Section title='Analytics' description='no domain is collecting yet'>
					<p className='text-body text-muted-foreground'>
						Turn on Analytics for a domain in its project to start counting visits. Nothing has to change
						inside the deployed app.
					</p>
				</Section>
			</Page>
		)
	}

	return (
		<Page
			actions={<Refresh onClick={() => analytics.refetch()} busy={analytics.isFetching} />}
			filters={
				<>
					<select
						aria-label='Site'
						value={selected ?? ''}
						onChange={event => setHostname(event.target.value)}
						className='w-auto'
					>
						{tracked.map(domain => (
							<option key={domain.id} value={domain.hostname}>
								{domain.hostname}
							</option>
						))}
					</select>
					<Segmented value={range} onChange={setRange} options={ranges} />
				</>
			}
		>
			<ErrorText error={analytics.error} />

			<Cells className='mb-10'>
				<MetricCard
					label='Unique visitors'
					value={traffic?.visitors ?? '-'}
					series={[pointsOf(traffic, point => point.visitors)]}
					format={([visitors]) => `${visitors} visitors`}
					windowLabel={windowLabel}
					hint={traffic && trend(traffic.visitors, traffic.previous.visitors)}
				/>
				<MetricCard
					label='Page views'
					value={traffic?.views ?? '-'}
					series={[pointsOf(traffic, point => point.views)]}
					format={([views]) => `${views} views`}
					windowLabel={windowLabel}
					hint={traffic && trend(traffic.views, traffic.previous.views)}
				/>
				<Cell label='Online now' value={traffic?.online ?? '-'} hint='last 5 minutes' />
				<Cell
					label='Visits'
					value={traffic?.visits ?? '-'}
					hint={traffic && trend(traffic.visits, traffic.previous.visits)}
				/>
				<Cell
					label='Avg visit'
					value={traffic ? duration(traffic.avg_duration) : '-'}
					hint={traffic && trend(traffic.avg_duration, traffic.previous.avg_duration)}
				/>
				<Cell
					label='Bounce rate'
					value={traffic ? `${Math.round(traffic.bounce_rate * 100)}%` : '-'}
					hint={traffic && trend(traffic.bounce_rate, traffic.previous.bounce_rate)}
				/>
			</Cells>

			<div className='grid grid-cols-1 gap-x-8 lg:grid-cols-[2fr_1fr]'>
				<Section title='Traffic' description={selected}>
					{traffic ? <TrafficChart traffic={traffic} range={range} /> : null}
				</Section>
				<Top title='Currently reading' rows={traffic?.online_pages} unit='visitors' />
			</div>

			<Section title='When people visit' description='views per hour, last four weeks'>
				<Activity series={activity.data?.series ?? []} />
			</Section>

			<div className='grid grid-cols-1 gap-x-8 md:grid-cols-2'>
				<Top title='Top pages' rows={traffic?.pages} unit='views' />
				<Top title='Referrers' rows={traffic?.referrers} unit='visitors' />
				<Top title='Countries and regions' rows={traffic?.countries} unit='visitors' />
				<Section title='Devices' description='share of visitors'>
					<Donut rows={traffic?.devices ?? []} />
				</Section>
				<Top title='Browsers' rows={traffic?.browsers} unit='visitors' />
				<Top title='Operating systems' rows={traffic?.systems} unit='visitors' />
				<Top title='Events' rows={traffic?.events} unit='fired' />
			</div>

			<Section title='Clear statistics' description='every event of this site, all ranges'>
				<ErrorText error={clear.error} />
				{confirmClear ? (
					<div className='flex gap-2'>
						<Button variant='danger' onClick={() => clear.mutate()} disabled={clear.isPending}>
							{clear.isPending ? 'Deleting…' : `Delete every event of ${selected}`}
						</Button>
						<Button variant='ghost' onClick={() => setConfirmClear(false)}>
							Cancel
						</Button>
					</div>
				) : (
					<Button variant='danger' onClick={() => setConfirmClear(true)}>
						Clear statistics
					</Button>
				)}
				<p className='mt-1 text-label text-muted-foreground'>
					The counters restart from zero and the history is gone. There is no undo and no export, and the
					other tracked domains are untouched. Collection stays on.
				</p>
			</Section>
		</Page>
	)
}

const CHART_WIDTH = 1000
const CHART_HEIGHT = 180

/**
 * Views filled, unique visitors on top, one hoverable band per bucket. Same SVG
 * vocabulary as the metric sparklines, so no charting dependency.
 */
function TrafficChart({ traffic, range }: { traffic: Traffic; range: AnalyticsRange }) {
	const points = dense(traffic.series, traffic.bucket)
	if (points.length < 2) {
		return <p className='text-body text-muted-foreground'>No visits in this window.</p>
	}

	const peak = Math.max(1, ...points.flatMap(point => [point.views, point.visitors]))
	const x = (index: number) => (index / (points.length - 1)) * CHART_WIDTH
	const y = (value: number) => CHART_HEIGHT - 1 - (value / peak) * (CHART_HEIGHT - 2)
	const views = curveThrough(points.map((point, index) => ({ x: x(index), y: y(point.views) })))
	const visitors = curveThrough(points.map((point, index) => ({ x: x(index), y: y(point.visitors) })))
	const band = CHART_WIDTH / points.length

	return (
		<div>
			<div className='flex items-baseline justify-between text-meta text-muted-foreground'>
				<span className='flex gap-3'>
					<span className='text-foreground'>Views</span>
					<span>Visitors</span>
				</span>
				<span>
					peak {peak} per {step(traffic.bucket)}
				</span>
			</div>
			<svg
				viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
				width='100%'
				height={160}
				preserveAspectRatio='none'
				role='img'
				aria-label={`Page views and unique visitors, last ${ranges.find(option => option.value === range)?.label}`}
				className='mt-1 block'
			>
				{[0.25, 0.5, 0.75].map(fraction => (
					<line
						key={fraction}
						x1={0}
						y1={CHART_HEIGHT * fraction}
						x2={CHART_WIDTH}
						y2={CHART_HEIGHT * fraction}
						stroke='currentColor'
						strokeWidth={1}
						vectorEffect='non-scaling-stroke'
						className='text-border'
					/>
				))}
				<path
					d={`${views} L${CHART_WIDTH},${CHART_HEIGHT} L0,${CHART_HEIGHT} Z`}
					fill='currentColor'
					fillOpacity={0.08}
					className='text-foreground'
				/>
				<path
					d={views}
					fill='none'
					stroke='currentColor'
					strokeWidth={1.25}
					vectorEffect='non-scaling-stroke'
					className='text-foreground'
				/>
				<path
					d={visitors}
					fill='none'
					stroke='currentColor'
					strokeWidth={1.25}
					strokeDasharray='3 3'
					vectorEffect='non-scaling-stroke'
					className='text-muted-foreground'
				/>
				{/* Native tooltips: the numbers are already in the page, this only dates them. */}
				{points.map((point, index) => (
					<rect
						key={point.at}
						x={x(index) - band / 2}
						y={0}
						width={band}
						height={CHART_HEIGHT}
						className='fill-transparent hover:fill-foreground/8'
					>
						<title>{`${new Date(point.at * 1000).toLocaleString()} · ${point.views} views · ${point.visitors} visitors`}</title>
					</rect>
				))}
			</svg>
			<div className='flex justify-between text-meta text-muted-foreground'>
				{axis(points, range).map((tick, index) => (
					<span key={`${tick.at}-${index}`}>{tick.label}</span>
				))}
			</div>
		</div>
	)
}

/** The sparkline series for one field of the chart, on the same filled buckets. */
function pointsOf(traffic: Traffic | undefined, value: (point: TrafficPoint) => number): Point[] {
	if (!traffic) {
		return []
	}
	return dense(traffic.series, traffic.bucket).map(point => ({ at: point.at * 1000, value: value(point) }))
}

function step(bucket: number) {
	return bucket >= 3600 ? `${bucket / 3600}h` : `${bucket / 60}m`
}

/** Five evenly spaced times under the chart, in whatever the range makes readable. */
function axis(points: TrafficPoint[], range: AnalyticsRange) {
	const format = (at: number) =>
		range === '24h'
			? new Date(at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			: new Date(at * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })
	return [0, 0.25, 0.5, 0.75, 1]
		.map(fraction => points[Math.round(fraction * (points.length - 1))])
		.filter(point => point !== undefined)
		.map(point => ({ at: point.at, label: format(point.at) }))
}

/** Devices are a handful of buckets that add up to the whole, so: a ring. */
function Donut({ rows }: { rows: Breakdown[] }) {
	const total = rows.reduce((sum, row) => sum + row.visitors, 0)
	if (total === 0) {
		return <p className='text-body text-muted-foreground'>Nothing yet.</p>
	}

	const circumference = 2 * Math.PI * 40
	let offset = 0
	return (
		<div className='flex items-center gap-4'>
			<svg viewBox='0 0 100 100' className='size-22 shrink-0' role='img' aria-label='Visitors by device'>
				{rows.map((row, index) => {
					const length = (row.visitors / total) * circumference
					const dash = offset
					offset += length
					return (
						<circle
							key={row.name}
							cx={50}
							cy={50}
							r={40}
							fill='none'
							stroke='currentColor'
							strokeOpacity={shade(index)}
							strokeWidth={14}
							strokeDasharray={`${length} ${circumference - length}`}
							strokeDashoffset={-dash}
							transform='rotate(-90 50 50)'
							className='text-foreground'
						/>
					)
				})}
			</svg>
			<ul className='min-w-0 flex-1 text-body'>
				{rows.map((row, index) => (
					<li key={row.name} className='flex items-center gap-2 py-0.5'>
						<span
							aria-hidden
							style={{ opacity: shade(index) }}
							className='size-2 shrink-0 rounded-xs bg-foreground'
						/>
						<span className='truncate'>{row.name}</span>
						<span className='ml-auto font-mono tabular-nums'>
							{Math.round((row.visitors / total) * 100)}%
						</span>
					</li>
				))}
			</ul>
		</div>
	)
}

/** The change against the window before, for a cell's hint line. */
function trend(current: number, previous: number) {
	const change = delta(current, previous)
	return change && `${change} vs previous`
}

/** Four weeks of views as weekday × hour, in the reader's own timezone. */
function Activity({ series }: { series: TrafficPoint[] }) {
	if (series.length === 0) {
		return <p className='text-body text-muted-foreground'>Nothing yet.</p>
	}

	const grid = weekdayHours(series)
	const peak = Math.max(1, ...grid.flat())
	return (
		<div>
			{grid.map((row, day) => (
				<div key={WEEKDAYS[day]} className='mb-0.5 flex items-center gap-1'>
					<span className='w-8 shrink-0 text-meta text-muted-foreground'>{WEEKDAYS[day]}</span>
					{row.map((views, hour) => (
						<div
							key={hour}
							className='h-3 flex-1 rounded-xs bg-foreground'
							style={{ opacity: views ? 0.15 + (views / peak) * 0.85 : 0.06 }}
							title={`${WEEKDAYS[day]} ${String(hour).padStart(2, '0')}:00 · ${views} views`}
						/>
					))}
				</div>
			))}
			<div className='flex justify-between pl-9 text-meta text-muted-foreground'>
				{['00', '06', '12', '18', '23'].map(hour => (
					<span key={hour}>{hour}</span>
				))}
			</div>
		</div>
	)
}

function shade(index: number) {
	return Math.max(0.15, 1 - index * 0.28)
}

function Top({ title, rows, unit }: { title: string; rows: Breakdown[] | undefined; unit: string }) {
	const value = (row: Breakdown) => (unit === 'views' || unit === 'fired' ? row.count : row.visitors)
	const peak = Math.max(1, ...(rows ?? []).map(value))
	return (
		<Section title={title} description={unit}>
			{rows?.length ? (
				<ul>
					{rows.map(row => (
						<li key={row.name} className='relative flex justify-between gap-4 px-1 py-1 text-body'>
							{/* The share bar sits behind the row instead of taking a column. */}
							<span
								aria-hidden
								style={{ width: `${(value(row) / peak) * 100}%` }}
								className='absolute inset-y-0 left-0 bg-foreground/8'
							/>
							<span className='relative truncate'>{row.name}</span>
							<span className='relative font-mono tabular-nums'>{value(row)}</span>
						</li>
					))}
				</ul>
			) : (
				<p className='text-body text-muted-foreground'>Nothing yet.</p>
			)}
		</Section>
	)
}

function duration(seconds: number) {
	const minutes = Math.floor(seconds / 60)
	return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}
