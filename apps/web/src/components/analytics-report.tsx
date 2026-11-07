import { type ReactNode, useState } from 'react'
import { IconChartBar } from '@tabler/icons-react'
import { cn } from 'cn'
import { LineChart } from '@/components/ui/line-chart'
import { Skeleton } from '@/components/ui/skeleton'
import type { AnalyticsReport, AnalyticsReportBody, AnalyticsRow, Annotation } from '../lib/api'
import { percent } from '../lib/format'
import { EmptyState, FilterChip, LoadingStatus, PendingReading, Segmented, StatStrip, textLink } from './primitives'

type Money = ((minor: number) => string) | null

/** Formats minor units in `currency`, with that currency's own number of decimals (none for JPY). */
export function moneyFormat(currency: string): Money {
	if (!currency) return null
	const format = new Intl.NumberFormat('en-US', { style: 'currency', currency })
	const scale = 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2)
	return (minor: number) => format.format(minor / scale)
}

function sessionLength(seconds: number) {
	const whole = Math.round(seconds)
	return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`
}

/** The change against the span before, green when it went the good way. */
function Delta({ now, before, lowerIsBetter }: { now: number; before: number | undefined; lowerIsBetter?: boolean }) {
	if (before === undefined || before === 0) return null
	const change = ((now - before) / before) * 100
	if (Math.abs(change) < 0.5) {
		return (
			<span className='text-sm text-muted'>
				0%<span className='sr-only'> against the range before</span>
			</span>
		)
	}
	const good = lowerIsBetter ? change < 0 : change > 0
	return (
		<span className={cn('text-sm', good ? 'text-success' : 'text-danger')}>
			{change > 0 ? '+' : ''}
			{Math.round(change)}%<span className='sr-only'>, {good ? 'better' : 'worse'} than the range before</span>
		</span>
	)
}

function reading(value: string, now: number, before: number | undefined, lowerIsBetter?: boolean) {
	return (
		// Wraps rather than clips: at 390 px a figure and its change outgrow the cell, and a figure wider than the cell
		// alone breaks inside itself, so touch and keyboard readers get all of it.
		<span className='inline-flex max-w-full flex-wrap items-baseline gap-x-2'>
			<span className='min-w-0 wrap-anywhere whitespace-normal'>{value}</span>
			<Delta now={now} before={before} lowerIsBetter={lowerIsBetter} />
		</span>
	)
}

const conversion = (r: AnalyticsReport) => r.customers / Math.max(r.visitors, 1)

export function Readings({ report, previous }: { report: AnalyticsReport; previous: AnalyticsReport | null }) {
	const money = moneyFormat(report.currency)
	const before = previous ?? undefined
	const items = [
		{ label: 'Online', value: report.online.toLocaleString('en-US') },
		{
			label: 'Visitors',
			value: reading(report.visitors.toLocaleString('en-US'), report.visitors, before?.visitors),
		},
		...(money
			? [
					{ label: 'Revenue', value: reading(money(report.revenue), report.revenue, before?.revenue) },
					{
						label: 'Conversion',
						value: reading(
							percent(conversion(report) * 100),
							conversion(report),
							before && conversion(before),
						),
					},
					{
						label: 'Revenue / visitor',
						value: (
							<span className='min-w-0 wrap-anywhere whitespace-normal'>
								{money(report.revenue / Math.max(report.visitors, 1))}
							</span>
						),
					},
				]
			: [
					{
						label: 'Pageviews',
						value: reading(report.pageviews.toLocaleString('en-US'), report.pageviews, before?.pageviews),
					},
				]),
		{
			label: 'Bounce rate',
			value: reading(percent(report.bounce_rate * 100), report.bounce_rate, before?.bounce_rate, true),
		},
		{
			label: 'Session',
			value: reading(sessionLength(report.session_seconds), report.session_seconds, before?.session_seconds),
		},
	]
	return <StatStrip items={items} />
}

const HOUR = 3600
const DAY = 86_400
const CHART_HEIGHT = 220

/** Visitors per bucket, the span before as a dashed line, and each annotation named in its bucket's tooltip. */
export function TrafficChart({ body }: { body: AnalyticsReportBody }) {
	const points = body.report.series
	const [first, second] = points
	const bucket = first && second ? second.at - first.at : HOUR
	const stamp = (at: number) =>
		bucket < DAY
			? new Date(at * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
			: new Date(at * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })
	// The axis gets 76 px a label (line-chart.tsx axisPicks), so an hourly tick drops the weekday the tooltip keeps.
	const tick = (at: number) =>
		bucket < DAY ? new Date(at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : stamp(at)
	const notes = (at: number) => {
		const texts: string[] = []
		for (const note of body.annotations) {
			if (note.at >= at && note.at < at + bucket) texts.push(annotationTitle(note))
		}
		return texts.length > 0 ? ` · ${texts.join(' · ')}` : ''
	}
	const series = [
		{ key: 'visitors', label: 'Visitors', area: !body.previous },
		...(body.previous ? [{ key: 'previous', label: 'Previous period', dashed: true }] : []),
	]
	return (
		<ReportCard title='Traffic'>
			<LineChart
				label='Visitors per period'
				height={CHART_HEIGHT}
				categoryLabel='Time'
				series={series}
				formatValue={value => Math.round(value).toLocaleString('en-US')}
				data={points.map((point, index) => ({
					key: String(point.at),
					label: stamp(point.at) + notes(point.at),
					axisLabel: tick(point.at),
					values: { visitors: point.visitors, previous: body.previous?.series[index]?.visitors },
				}))}
			/>
		</ReportCard>
	)
}

/** One card of a report: its title with what acts on it, then the body. `level` 3 sits under a Section's own title. */
export function ReportCard({
	title,
	level = 2,
	actions,
	children,
}: {
	title: string
	level?: 2 | 3
	actions?: ReactNode
	children: ReactNode
}) {
	const Heading = level === 3 ? 'h3' : 'h2'
	return (
		<section className='flex min-w-0 flex-col rounded-surface border bg-surface p-4'>
			<header className='mb-3 flex h-11 items-center justify-between gap-4'>
				<Heading className='min-w-0 truncate font-medium'>{title}</Heading>
				{actions}
			</header>
			{children}
		</section>
	)
}

export function annotationTitle(note: Annotation) {
	if (note.source === 'x') return `X: @${note.author}`
	if (note.source === 'reddit') return `Reddit: ${note.text}`
	return note.text
}

type OnPick = (dimension: string, value: string) => void

/** Every breakdown card of a report. `onPick` filters the report to a clicked row. */
export function Breakdowns({
	report,
	onPick,
	children,
}: {
	report: AnalyticsReport
	onPick?: OnPick
	children?: ReactNode
}) {
	const money = moneyFormat(report.currency)
	return (
		<div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
			<Breakdown
				title='Sources'
				money={money}
				onPick={onPick}
				views={[
					{ value: 'channel', label: 'Channel', rows: report.channels },
					{ value: 'referrer', label: 'Referrer', rows: report.referrers },
					{ value: 'campaign', label: 'Campaign', rows: report.campaigns },
				]}
			/>
			<Breakdown
				title='Pages'
				money={money}
				onPick={onPick}
				views={[
					{ value: 'page', label: 'Top', rows: report.pages },
					{ value: 'entry_page', label: 'Entry', rows: report.entry_pages },
					{ value: 'exit_page', label: 'Exit', rows: report.exit_pages },
				]}
			/>
			<Breakdown
				title='Locations'
				money={money}
				onPick={onPick}
				views={[
					{ value: 'location', label: 'Country', rows: report.locations },
					{ value: 'region', label: 'Region', rows: report.regions },
					{ value: 'city', label: 'City', rows: report.cities },
				]}
				footer={<GeoCredit />}
			/>
			<Breakdown
				title='Devices'
				money={money}
				onPick={onPick}
				views={[
					{ value: 'device', label: 'Device', rows: report.devices },
					{ value: 'browser', label: 'Browser', rows: report.browsers },
					{ value: 'os', label: 'OS', rows: report.systems },
				]}
			/>
			<Breakdown
				title='Goals'
				money={money}
				onPick={onPick}
				views={[{ value: 'goal', label: 'Goal', rows: report.goals }]}
			/>
			{children}
		</div>
	)
}

export function NoVisits({ description }: { description: string }) {
	return (
		<div className='rounded-surface border bg-surface'>
			<EmptyState icon={IconChartBar} title='No visits in this range' description={description} />
		</div>
	)
}

/** The report's shape while it loads: the readings, the traffic chart at its own height and the breakdowns. */
export function ReportSkeleton() {
	return (
		<div className='flex flex-col gap-4'>
			<LoadingStatus label='Loading the report' />
			<div aria-hidden>
				{/* The currency is unknown until the report lands, so the five cells every report has. */}
				<StatStrip
					items={['Online', 'Visitors', 'Pageviews', 'Bounce rate', 'Session'].map(label => ({
						label,
						value: <PendingReading label={label} />,
					}))}
				/>
			</div>
			<div aria-hidden>
				<ReportCard title='Traffic'>
					<div style={{ height: CHART_HEIGHT }}>
						<Skeleton lines={6} />
					</div>
				</ReportCard>
			</div>
			<div aria-hidden className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
				{['Sources', 'Pages', 'Locations', 'Devices', 'Goals'].map(title => (
					<ReportCard key={title} title={title}>
						<Skeleton lines={5} />
					</ReportCard>
				))}
			</div>
		</div>
	)
}

/** A favicon for a referrer host, fetched by the browser from DuckDuckGo's public icon service. */
function SourceIcon({ name }: { name: string }) {
	if (!name.includes('.') || (name.includes('/') && !name.startsWith('t.co/'))) return null
	const host = name.startsWith('t.co/') ? 'x.com' : name
	return (
		<img
			alt=''
			loading='lazy'
			referrerPolicy='no-referrer'
			className='size-4 shrink-0'
			src={`https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`}
		/>
	)
}

const breakdownRow =
	'relative col-span-full grid min-h-9 w-full grid-cols-subgrid items-center rounded-[calc(var(--radius-control)-4px)] px-2 py-1.5 text-left text-sm pointer-coarse:min-h-11'

/** One card of the report: a ranked list of one dimension, each bar as wide as its share of the top row. */
function Breakdown({
	title,
	views,
	money,
	onPick,
	footer,
}: {
	title: string
	views: [
		{ value: string; label: string; rows: AnalyticsRow[] },
		...{ value: string; label: string; rows: AnalyticsRow[] }[],
	]
	money: Money
	onPick?: OnPick
	footer?: ReactNode
}) {
	const [picked, setPicked] = useState(views[0].value)
	const view = views.find(option => option.value === picked) ?? views[0]
	const top = Math.max(1, ...view.rows.map(row => row.visitors))

	return (
		<ReportCard
			title={title}
			actions={
				views.length > 1 ? (
					<Segmented label={title} value={picked} onChange={setPicked} options={views} />
				) : null
			}
		>
			<div
				className={cn(
					'grid gap-x-6',
					money ? 'grid-cols-[minmax(0,1fr)_auto_auto]' : 'grid-cols-[minmax(0,1fr)_auto]',
				)}
			>
				<div className='col-span-full grid grid-cols-subgrid px-2 pb-1 text-xs text-muted'>
					<span>{view.label}</span>
					<span className='text-right'>Visitors</span>
					{money ? <span className='text-right'>Revenue</span> : null}
				</div>
				{view.rows.length === 0 ? (
					<p className='col-span-full px-2 py-6 text-center text-sm text-muted'>
						Nothing recorded in this range
					</p>
				) : (
					<ol className='col-span-full grid grid-cols-subgrid gap-y-0.5'>
						{view.rows.map(row => {
							const { name } = row
							const cells = (
								<>
									<span
										aria-hidden
										className='absolute inset-y-0 left-0 rounded-[calc(var(--radius-control)-4px)] bg-accent/12'
										style={{ width: `${(row.visitors / top) * 100}%` }}
									/>
									<span className='relative flex min-w-0 items-center gap-2'>
										{view.value === 'referrer' ? <SourceIcon name={row.name} /> : null}
										{/* A shared report has no filter to open, so its long names wrap instead of hiding. */}
										<span className={onPick ? 'truncate' : '[overflow-wrap:anywhere]'}>{name}</span>
									</span>
									<span className='relative text-right tabular-nums'>
										{row.visitors.toLocaleString('en-US')}
										<span className='sr-only'> visitors</span>
									</span>
									{money ? (
										<span className='relative text-right tabular-nums'>
											{money(row.revenue)}
											<span className='sr-only'> revenue</span>
										</span>
									) : null}
								</>
							)
							return (
								<li key={row.name} className='col-span-full grid grid-cols-subgrid'>
									{onPick ? (
										<button
											type='button'
											onClick={() => onPick(view.value, row.name)}
											title={`Show only ${name}`}
											className={cn(
												breakdownRow,
												'transition-colors hover:bg-surface-muted active:bg-surface-pressed',
											)}
										>
											{cells}
										</button>
									) : (
										<div className={breakdownRow}>{cells}</div>
									)}
								</li>
							)
						})}
					</ol>
				)}
			</div>
			{footer}
		</ReportCard>
	)
}

/** DB-IP Lite is CC BY 4.0: every view that shows a place read from it credits it. */
export function GeoCredit() {
	return (
		<p className='mt-auto px-2 pt-3 text-xs text-muted'>
			<a
				href='https://db-ip.com'
				target='_blank'
				rel='noreferrer'
				className={cn(textLink, 'hover:text-foreground')}
			>
				IP Geolocation by DB-IP
				<span className='sr-only'> (opens in a new tab)</span>
			</a>
		</p>
	)
}

export function FilterChips({ filters, onRemove }: { filters: [string, string][]; onRemove: (index: number) => void }) {
	return (
		<div className='flex flex-wrap items-center gap-2'>
			{filters.map(([dimension, value], index) => {
				const name = dimension.replaceAll('_', ' ')
				return (
					<FilterChip key={`${dimension}:${value}`} label={name} onRemove={() => onRemove(index)}>
						<span className='text-muted'>{name}</span>
						{value}
					</FilterChip>
				)
			})}
		</div>
	)
}
