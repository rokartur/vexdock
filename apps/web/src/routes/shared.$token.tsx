import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { Breakdowns, NoVisits, Readings, TrafficChart } from '../components/analytics-report'
import { ErrorText, Segmented } from '../components/primitives'
import { type AnalyticsRange, api } from '../lib/api'

export const Route = createFileRoute('/shared/$token')({
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
	const [range, setRange] = useState<AnalyticsRange>('7d')
	const report = useQuery({
		queryKey: ['shared', token, range],
		queryFn: () => api.sharedReport(token, { range, filters: [], compare: true }),
		placeholderData: keepPreviousData,
	})

	return (
		<main className='mx-auto flex max-w-6xl flex-col gap-4 p-6'>
			<header className='flex flex-wrap items-center justify-between gap-3'>
				<h1 className='text-xl font-medium'>{report.data?.domain.hostname ?? 'Analytics'}</h1>
				<Segmented label='Range' value={range} options={ranges} onChange={setRange} />
			</header>
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
			) : report.error ? (
				<ErrorText error={report.error} />
			) : (
				<Skeleton label='Loading the report' />
			)}
		</main>
	)
}
