import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
	Area,
	AreaChart,
	CartesianGrid,
	Cell as PieSlice,
	Pie,
	PieChart,
	ResponsiveContainer,
	Tooltip,
	type TooltipContentProps,
	XAxis,
	YAxis,
} from 'recharts'
import { MetricCard, type Point } from '../components/metric-chart'
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

/** Views filled, unique visitors dashed on top, one tooltip per bucket. */
function TrafficChart({ traffic, range }: { traffic: Traffic; range: AnalyticsRange }) {
	const points = dense(traffic.series, traffic.bucket)
	if (points.length < 2) {
		return <p className='text-body text-muted-foreground'>No visits in this window.</p>
	}

	const peak = Math.max(1, ...points.flatMap(point => [point.views, point.visitors]))

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
			<div
				className='mt-1 h-45'
				role='img'
				aria-label={`Page views and unique visitors, last ${ranges.find(option => option.value === range)?.label}`}
			>
				<ResponsiveContainer width='100%' height='100%'>
					<AreaChart data={points} margin={{ top: 1, right: 0, bottom: 0, left: 0 }}>
						<CartesianGrid vertical={false} stroke='var(--border)' />
						<XAxis
							dataKey='at'
							type='number'
							domain={['dataMin', 'dataMax']}
							ticks={ticksOf(points)}
							tickFormatter={at => tickLabel(at, range)}
							axisLine={false}
							tickLine={false}
							tickMargin={6}
							tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
						/>
						<YAxis type='number' domain={[0, peak]} hide />
						<Tooltip content={TrafficTooltip} cursor={{ stroke: 'var(--border)', strokeWidth: 1 }} />
						<Area
							dataKey='views'
							type='monotone'
							stroke='var(--foreground)'
							strokeWidth={1.25}
							fill='var(--foreground)'
							fillOpacity={0.08}
							dot={false}
							activeDot={{ r: 2, fill: 'var(--foreground)', stroke: 'none' }}
							isAnimationActive={false}
						/>
						<Area
							dataKey='visitors'
							type='monotone'
							stroke='var(--muted-foreground)'
							strokeWidth={1.25}
							strokeDasharray='3 3'
							fill='none'
							dot={false}
							activeDot={{ r: 2, fill: 'var(--muted-foreground)', stroke: 'none' }}
							isAnimationActive={false}
						/>
					</AreaChart>
				</ResponsiveContainer>
			</div>
		</div>
	)
}

function TrafficTooltip({ active, label, payload }: TooltipContentProps) {
	if (!(active && payload.length)) {
		return null
	}
	const read = (key: string) => payload.find(entry => entry.dataKey === key)?.value ?? 0
	return (
		<div className='rounded-md border border-border bg-popover px-2 py-1 text-meta'>
			<div className='text-muted-foreground'>{new Date(Number(label) * 1000).toLocaleString()}</div>
			<div>
				{read('views')} views · {read('visitors')} visitors
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
function ticksOf(points: TrafficPoint[]) {
	return [0, 0.25, 0.5, 0.75, 1]
		.map(fraction => points[Math.round(fraction * (points.length - 1))]?.at)
		.filter(at => at !== undefined)
}

function tickLabel(at: number, range: AnalyticsRange) {
	return range === '24h'
		? new Date(at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		: new Date(at * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Devices are a handful of buckets that add up to the whole, so: a ring. */
function Donut({ rows }: { rows: Breakdown[] }) {
	const total = rows.reduce((sum, row) => sum + row.visitors, 0)
	if (total === 0) {
		return <p className='text-body text-muted-foreground'>Nothing yet.</p>
	}

	return (
		<div className='flex items-center gap-4'>
			<div className='size-22 shrink-0' role='img' aria-label='Visitors by device'>
				<ResponsiveContainer width='100%' height='100%'>
					<PieChart>
						<Pie
							data={rows}
							dataKey='visitors'
							nameKey='name'
							innerRadius='72%'
							outerRadius='100%'
							startAngle={90}
							endAngle={-270}
							stroke='none'
							isAnimationActive={false}
						>
							{rows.map((row, index) => (
								<PieSlice key={row.name} fill='var(--foreground)' fillOpacity={shade(index)} />
							))}
						</Pie>
					</PieChart>
				</ResponsiveContainer>
			</div>
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
