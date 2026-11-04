import { useState } from 'react'
import { IconChartBar, IconUsers } from '@tabler/icons-react'
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { CodeBlock } from '@/components/ui/code-block'
import { Skeleton } from '@/components/ui/skeleton'
import { MetricCard } from '../components/metric-chart'
import { EmptyState, ErrorText, Page, Segmented, StatStrip } from '../components/primitives'
import { type AnalyticsRange, type AnalyticsReport, type AnalyticsRow, api } from '../lib/api'
import { percent } from '../lib/format'
import { preload } from '../lib/queries'

const reportQuery = (domainId: string, range: AnalyticsRange) =>
	queryOptions({
		queryKey: ['analytics', domainId, range],
		queryFn: () => api.analyticsReport(domainId, range),
		refetchInterval: 60_000,
		placeholderData: keepPreviousData,
	})

export const Route = createFileRoute('/analytics/$domainId')({
	loader: ({ context: { queryClient }, params: { domainId } }) => preload(queryClient, reportQuery(domainId, '7d')),
	component: SiteReport,
})

const ranges = [
	{ value: '24h', label: '24h' },
	{ value: '7d', label: '7d' },
	{ value: '30d', label: '30d' },
	{ value: '90d', label: '90d' },
] as const satisfies readonly { value: AnalyticsRange; label: string }[]

const SNIPPET = '<script defer src="/_vx/script.js"></script>'

/** Formats minor units in `currency`, with that currency's own number of decimals (none for JPY). */
function moneyFormat(currency: string) {
	if (!currency) return null
	const format = new Intl.NumberFormat(undefined, { style: 'currency', currency })
	const scale = 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2)
	return (minor: number) => format.format(minor / scale)
}

function sessionLength(seconds: number) {
	const whole = Math.round(seconds)
	return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`
}

function SiteReport() {
	const { domainId } = Route.useParams()
	const [range, setRange] = useState<AnalyticsRange>('7d')
	const report = useQuery(reportQuery(domainId, range))
	const hostname = report.data?.domain.hostname

	return (
		<Page
			labels={{ [domainId]: hostname ?? domainId }}
			name={hostname}
			filters={<Segmented label='Range' value={range} onChange={setRange} options={ranges} />}
		>
			<ErrorText error={report.error} />
			{report.data ? (
				<Report report={report.data.report} range={range} />
			) : (
				<Skeleton label='Loading the report' className='p-5' />
			)}
		</Page>
	)
}

function Report({ report, range }: { report: AnalyticsReport; range: AnalyticsRange }) {
	const money = moneyFormat(report.currency)
	const revenue = money
		? [
				{ label: 'Revenue', value: money(report.revenue) },
				{ label: 'Conversion', value: percent((report.customers / Math.max(report.visitors, 1)) * 100) },
				{ label: 'Revenue / visitor', value: money(report.revenue / Math.max(report.visitors, 1)) },
			]
		: [{ label: 'Pageviews', value: report.pageviews.toLocaleString() }]
	const series = {
		Visitors: report.series.map(point => ({ at: point.at * 1000, value: point.visitors })),
		Pageviews: report.series.map(point => ({ at: point.at * 1000, value: point.pageviews })),
	}

	return (
		<div className='flex flex-col gap-4'>
			<StatStrip
				items={[
					{ label: 'Visitors', value: report.visitors.toLocaleString() },
					...revenue,
					{ label: 'Bounce rate', value: percent(report.bounce_rate * 100) },
					{ label: 'Session', value: sessionLength(report.session_seconds) },
					{ label: 'Online', value: report.online },
				]}
			/>
			{report.visitors === 0 ? (
				<div className='rounded-surface border bg-surface'>
					<EmptyState
						icon={IconChartBar}
						title={`No visits in the last ${range}`}
						description='Add the script below to the site, then open a page on it.'
					/>
				</div>
			) : (
				<div className='overflow-hidden rounded-surface border'>
					<MetricCard
						label='Traffic'
						icon={IconUsers}
						value={report.pageviews.toLocaleString()}
						hint='pageviews'
						series={series}
						format={value => Math.round(value).toLocaleString()}
						windowLabel={`last ${range}`}
						height={220}
						axis
					/>
				</div>
			)}
			<div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
				<Breakdown
					title='Sources'
					money={money}
					views={[
						{ value: 'channel', label: 'Channel', rows: report.channels },
						{ value: 'referrer', label: 'Referrer', rows: report.referrers },
						{ value: 'campaign', label: 'Campaign', rows: report.campaigns },
					]}
				/>
				<Breakdown
					title='Pages'
					money={money}
					views={[
						{ value: 'top', label: 'Top', rows: report.pages },
						{ value: 'entry', label: 'Entry', rows: report.entry_pages },
						{ value: 'exit', label: 'Exit', rows: report.exit_pages },
					]}
				/>
				<Breakdown
					title='Locations'
					money={money}
					views={[{ value: 'region', label: 'Region', rows: report.locations }]}
				/>
				<Breakdown
					title='Devices'
					money={money}
					views={[
						{ value: 'device', label: 'Device', rows: report.devices },
						{ value: 'browser', label: 'Browser', rows: report.browsers },
						{ value: 'os', label: 'OS', rows: report.systems },
					]}
				/>
				<Breakdown title='Goals' money={money} views={[{ value: 'goal', label: 'Goal', rows: report.goals }]} />
				<Install />
			</div>
		</div>
	)
}

/** One card of the report: a ranked list of one dimension, each bar as wide as its share of the top row. */
function Breakdown({
	title,
	views,
	money,
}: {
	title: string
	views: [
		{ value: string; label: string; rows: AnalyticsRow[] },
		...{ value: string; label: string; rows: AnalyticsRow[] }[],
	]
	money: ((minor: number) => string) | null
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
						<li
							key={row.name}
							className='relative flex items-center justify-between gap-4 px-2 py-1.5 text-sm'
						>
							<span
								aria-hidden
								className='absolute inset-y-0 left-0 rounded-[calc(var(--radius-control)-4px)] bg-accent/12'
								style={{ width: `${(row.visitors / top) * 100}%` }}
							/>
							<span className='relative min-w-0 truncate' title={row.name}>
								{row.name || 'Direct'}
							</span>
							<span className='relative flex shrink-0 gap-6 tabular-nums'>
								<span className='w-16 text-right'>{row.visitors.toLocaleString()}</span>
								{money ? (
									<span className='w-20 text-right text-success'>{money(row.revenue)}</span>
								) : null}
							</span>
						</li>
					))}
				</ol>
			)}
		</section>
	)
}

function Install() {
	const { domainId } = Route.useParams()
	return (
		<section className='flex min-w-0 flex-col gap-3 rounded-surface border bg-surface p-4'>
			<h2 className='flex h-8 items-center font-medium'>Install</h2>
			<p className='text-sm text-muted'>
				Add this to every page. It loads from the site&apos;s own hostname, which Vexdock routes to the manager.
			</p>
			<CodeBlock filename='index.html' language='html' code={SNIPPET} />
			<p className='text-sm text-muted'>
				Count a goal with <code className='font-mono text-xs'>window.vx(&apos;signup&apos;)</code>. For revenue,
				post each payment to <code className='font-mono text-xs'>POST /api/domains/{domainId}/payments</code>{' '}
				with the buyer&apos;s <code className='font-mono text-xs'>vx_vid</code> cookie as{' '}
				<code className='font-mono text-xs'>visitor_id</code>.
			</p>
		</section>
	)
}
