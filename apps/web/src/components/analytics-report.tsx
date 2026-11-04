import { type ReactNode, useState } from 'react'
import { IconChartBar, IconX } from '@tabler/icons-react'
import { LineChart } from '@/components/ui/line-chart'
import type { AnalyticsReport, AnalyticsReportBody, AnalyticsRow, Annotation } from '../lib/api'
import { percent } from '../lib/format'
import { EmptyState, IconButton, Segmented, StatStrip } from './primitives'

export type Money = ((minor: number) => string) | null

/** Formats minor units in `currency`, with that currency's own number of decimals (none for JPY). */
export function moneyFormat(currency: string): Money {
	if (!currency) return null
	const format = new Intl.NumberFormat(undefined, { style: 'currency', currency })
	const scale = 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2)
	return (minor: number) => format.format(minor / scale)
}

export function sessionLength(seconds: number) {
	const whole = Math.round(seconds)
	return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`
}

/** The change against the span before, green when it went the good way. */
function Delta({ now, before, lowerIsBetter }: { now: number; before: number | undefined; lowerIsBetter?: boolean }) {
	if (before === undefined || before === 0) return null
	const change = ((now - before) / before) * 100
	if (Math.abs(change) < 0.5) return <span className='ml-2 text-sm text-muted'>0%</span>
	const good = lowerIsBetter ? change < 0 : change > 0
	return (
		<span className={`ml-2 text-sm ${good ? 'text-success' : 'text-danger'}`}>
			{change > 0 ? '+' : ''}
			{Math.round(change)}%
		</span>
	)
}

function reading(value: ReactNode, now: number, before: number | undefined, lowerIsBetter?: boolean) {
	return (
		<span className='inline-flex items-baseline'>
			{value}
			<Delta now={now} before={before} lowerIsBetter={lowerIsBetter} />
		</span>
	)
}

const conversion = (r: AnalyticsReport) => r.customers / Math.max(r.visitors, 1)

export function Readings({ report, previous }: { report: AnalyticsReport; previous: AnalyticsReport | null }) {
	const money = moneyFormat(report.currency)
	const before = previous ?? undefined
	const items = [
		{ label: 'Online', value: report.online },
		{ label: 'Visitors', value: reading(report.visitors.toLocaleString(), report.visitors, before?.visitors) },
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
					{ label: 'Revenue / visitor', value: money(report.revenue / Math.max(report.visitors, 1)) },
				]
			: [
					{
						label: 'Pageviews',
						value: reading(report.pageviews.toLocaleString(), report.pageviews, before?.pageviews),
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

/** Visitors per bucket, the span before as a dashed line, and each annotation named in its bucket's tooltip. */
export function TrafficChart({ body }: { body: AnalyticsReportBody }) {
	const points = body.report.series
	const [first, second] = points
	const bucket = first && second ? second.at - first.at : HOUR
	const stamp = (at: number) =>
		bucket < DAY
			? new Date(at * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
			: new Date(at * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })
	// The axis gets 76 px a label (line-chart.tsx axisPicks), so an hourly tick drops the weekday the tooltip keeps.
	const tick = (at: number) =>
		bucket < DAY ? new Date(at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : stamp(at)
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
		<section className='rounded-surface border bg-surface p-4'>
			<h2 className='mb-3 font-medium'>Traffic</h2>
			<LineChart
				label='Visitors per period'
				height={220}
				categoryLabel='Time'
				series={series}
				formatValue={value => Math.round(value).toLocaleString()}
				data={points.map((point, index) => ({
					key: String(point.at),
					label: stamp(point.at) + notes(point.at),
					axisLabel: tick(point.at),
					values: { visitors: point.visitors, previous: body.previous?.series[index]?.visitors },
				}))}
			/>
		</section>
	)
}

export function annotationTitle(note: Annotation) {
	if (note.source === 'x') return `X: @${note.author}`
	if (note.source === 'reddit') return `Reddit: ${note.text}`
	return note.text
}

export type Pick = (dimension: string, value: string) => void

/** Every breakdown card of a report. `onPick` filters the report to a clicked row. */
export function Breakdowns({
	report,
	onPick,
	children,
}: {
	report: AnalyticsReport
	onPick?: Pick
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

/** The empty report: nothing to chart yet. */
export function NoVisits({ description }: { description: string }) {
	return (
		<div className='rounded-surface border bg-surface'>
			<EmptyState icon={IconChartBar} title='No visits in this range' description={description} />
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
			className='rounded-sm size-4 shrink-0'
			src={`https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`}
		/>
	)
}

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
	onPick?: Pick
	footer?: ReactNode
}) {
	const [picked, setPicked] = useState(views[0].value)
	const view = views.find(option => option.value === picked) ?? views[0]
	const top = Math.max(1, ...view.rows.map(row => row.visitors))

	return (
		<section className='flex min-w-0 flex-col rounded-surface border bg-surface p-4'>
			<header className='mb-3 flex h-8 items-center justify-between gap-4'>
				<h2 className='font-medium'>{title}</h2>
				{views.length > 1 ? (
					<Segmented label={title} value={picked} onChange={setPicked} options={views} />
				) : null}
			</header>
			<div className='flex justify-between px-2 pb-1 text-xs text-muted'>
				<span>{view.label}</span>
				<span className='flex gap-6'>
					<span className='w-16 text-right'>Visitors</span>
					{money ? <span className='w-20 text-right'>Revenue</span> : null}
				</span>
			</div>
			{view.rows.length === 0 ? (
				<p className='px-2 py-6 text-center text-sm text-muted'>Nothing recorded in this range</p>
			) : (
				<ol className='flex flex-col gap-0.5'>
					{view.rows.map(row => (
						<li key={row.name}>
							<button
								type='button'
								disabled={!onPick}
								onClick={() => onPick?.(view.value, row.name)}
								title={onPick ? `Show only ${row.name || 'Direct'}` : row.name}
								className='relative flex w-full items-center justify-between gap-4 rounded-[calc(var(--radius-control)-4px)] px-2 py-1.5 text-left text-sm enabled:hover:bg-surface-muted'
							>
								<span
									aria-hidden
									className='absolute inset-y-0 left-0 rounded-[calc(var(--radius-control)-4px)] bg-accent/12'
									style={{ width: `${(row.visitors / top) * 100}%` }}
								/>
								<span className='relative flex min-w-0 items-center gap-2'>
									{view.value === 'referrer' ? <SourceIcon name={row.name} /> : null}
									<span className='truncate'>{row.name || 'Direct'}</span>
								</span>
								<span className='relative flex shrink-0 gap-6 tabular-nums'>
									<span className='w-16 text-right'>{row.visitors.toLocaleString()}</span>
									{money ? (
										<span className='w-20 text-right text-success'>{money(row.revenue)}</span>
									) : null}
								</span>
							</button>
						</li>
					))}
				</ol>
			)}
			{footer}
		</section>
	)
}

/** DB-IP Lite is CC BY 4.0: every view that shows a place read from it credits it. */
export function GeoCredit() {
	return (
		<p className='mt-auto px-2 pt-3 text-xs text-muted'>
			<a href='https://db-ip.com' target='_blank' rel='noreferrer' className='hover:text-foreground'>
				IP Geolocation by DB-IP
			</a>
		</p>
	)
}

/** The filters a report is narrowed to, each removable. */
export function FilterChips({ filters, onRemove }: { filters: [string, string][]; onRemove: (index: number) => void }) {
	return (
		<div className='flex flex-wrap items-center gap-2'>
			{filters.map(([dimension, value], index) => (
				<span
					key={`${dimension}:${value}`}
					className='inline-flex items-center gap-1 rounded-control border bg-surface py-0.5 pr-0.5 pl-2 text-sm'
				>
					<span className='text-muted'>{dimension.replace('_', ' ')}</span>
					{value || 'Direct'}
					<IconButton label={`Remove the ${dimension} filter`} icon={IconX} onClick={() => onRemove(index)} />
				</span>
			))}
		</div>
	)
}
