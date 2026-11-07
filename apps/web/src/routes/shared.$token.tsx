import { useEffect } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Breakdowns, NoVisits, Readings, ReportSkeleton, TrafficChart } from '../components/analytics-report'
import { EmptyState, ErrorText, Segmented } from '../components/primitives'
import { type AnalyticsRange, ApiError, api } from '../lib/api'

export const Route = createFileRoute('/shared/$token')({
	validateSearch: (search: Record<string, unknown>): { range?: AnalyticsRange } => ({
		range: ranges.find(option => option.value === search.range)?.value,
	}),
	component: SharedReport,
	head: () => ({ meta: [{ title: 'Analytics · Vexdock' }, { name: 'robots', content: 'noindex' }] }),
})

const ranges = [
	{ value: 'today', label: 'Today' },
	{ value: '7d', label: '7d' },
	{ value: '30d', label: '30d' },
	{ value: '12m', label: '12m' },
] as const satisfies readonly { value: AnalyticsRange; label: string }[]

/** The read-only report a site owner shares by link: no session, no visitors, no settings. */
function SharedReport() {
	const { token } = Route.useParams()
	const range = Route.useSearch().range ?? '7d'
	const navigate = useNavigate({ from: Route.fullPath })
	const setRange = (next: AnalyticsRange) => navigate({ search: { range: next }, replace: true })
	const report = useQuery({
		queryKey: ['shared', token, range],
		queryFn: () => api.sharedReport(token, { range, filters: [], compare: true }),
		placeholderData: keepPreviousData,
	})
	const hostname = report.data?.domain.hostname
	// Two shared reports open side by side would share the head's fixed title.
	useEffect(() => {
		if (hostname) document.title = `${hostname} analytics · Vexdock`
	}, [hostname])

	// The manager answers 404 for a token it no longer knows: sharing was turned off or the link was replaced.
	if (report.error instanceof ApiError && report.error.status === 404) {
		return (
			<main className='mx-auto flex max-w-6xl flex-col gap-4 p-6 max-sm:px-4'>
				<h1 className='text-2xl font-medium max-sm:text-xl'>Analytics</h1>
				<EmptyState
					title='This link no longer works'
					description='Its owner turned sharing off or made a new link; ask them for the current one.'
				/>
			</main>
		)
	}

	return (
		<main className='mx-auto flex max-w-6xl flex-col gap-4 p-6 max-sm:px-4'>
			<header className='flex flex-wrap items-center justify-between gap-3'>
				<h1 className='min-w-0 text-2xl font-medium wrap-anywhere max-sm:text-xl'>
					{report.data?.domain.hostname ?? 'Analytics'}
				</h1>
				<Segmented label='Range' value={range} options={ranges} onChange={setRange} />
			</header>
			{/* A failed range switch keeps the last report on screen; the error says it is stale. */}
			<ErrorText error={report.error} />
			{report.data ? (
				<>
					<Readings report={report.data.report} previous={report.data.previous} />
					{report.data.report.visitors === 0 ? (
						<NoVisits description='Nobody visited in this range.' />
					) : (
						<TrafficChart body={report.data} />
					)}
					<Breakdowns report={report.data.report} />
				</>
			) : report.error ? null : (
				<ReportSkeleton />
			)}
		</main>
	)
}
