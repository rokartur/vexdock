import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { GeoCredit, moneyFormat } from '../components/analytics-report'
import { type Columns, DataTable, RowTitle, columnsFor } from '../components/data-table'
import { EmptyState, ErrorText, RelativeTime, Section, Timeline } from '../components/primitives'
import { type AnalyticsVisitor, api } from '../lib/api'
import { useSpan } from './analytics.$domainId'

export const Route = createFileRoute('/analytics/$domainId/visitors')({ component: Visitors })

const place = (row: AnalyticsVisitor) => [row.city, row.location].filter(Boolean).join(', ')
const device = (row: AnalyticsVisitor) => `${row.device}, ${row.browser}, ${row.os}`
const countCell = ({ getValue }: { getValue: () => number }) => getValue().toLocaleString('en-US')

function visitorColumns(): Columns<AnalyticsVisitor> {
	const cell = columnsFor<AnalyticsVisitor>()
	return [
		cell.accessor('visitor', {
			header: 'Visitor',
			meta: { mono: true },
			cell: ({ getValue }) => <RowTitle>{getValue()}</RowTitle>,
		}),
		cell.accessor(row => row.referrer || row.channel, { id: 'source', header: 'Source' }),
		cell.accessor(place, { id: 'place', header: 'Location', cell: ({ getValue }) => getValue() || '-' }),
		cell.accessor(device, { id: 'device', header: 'Device' }),
		cell.accessor('sessions', { header: 'Sessions', meta: { align: 'right', mono: true }, cell: countCell }),
		cell.accessor('pageviews', { header: 'Pageviews', meta: { align: 'right', mono: true }, cell: countCell }),
		cell.accessor('goals', { header: 'Goals', meta: { align: 'right', mono: true }, cell: countCell }),
		cell.accessor('revenue', {
			header: 'Revenue',
			meta: { align: 'right', mono: true },
			cell: ({ row }) => {
				const money = moneyFormat(row.original.currency)
				return money && row.original.revenue > 0 ? money(row.original.revenue) : null
			},
		}),
		cell.accessor('last_seen', { header: 'Last seen', cell: ({ getValue }) => <RelativeTime at={getValue()} /> }),
	]
}

function Visitors() {
	const { domainId } = Route.useParams()
	const { span } = useSpan()
	const [open, setOpen] = useState<string | null>(null)
	const visitors = useQuery({
		queryKey: ['analytics', domainId, 'visitors', span],
		queryFn: () => api.analyticsVisitors(domainId, span),
		placeholderData: keepPreviousData,
	})
	const columns = useMemo(visitorColumns, [])
	const data = visitors.data?.visitors ?? []
	const total = visitors.data?.total
	let empty = { title: 'No visitors in this range', description: 'Pick a longer range above.' }
	if (span.filters?.length) empty = { title: 'No visitors match these filters', description: 'Remove one above.' }
	// Custom dates leave `range` in the URL, so `all` alone does not mean the whole history.
	else if (span.range === 'all' && !(span.from && span.to))
		empty = { title: 'Nobody has visited yet', description: 'Overview has the script that counts them.' }

	return (
		<Section title='Visitors' total={total?.toLocaleString('en-US')} fill>
			<DataTable
				data={data}
				columns={columns}
				loading={visitors.isLoading}
				error={visitors.error}
				getRowId={row => row.visitor}
				filter='Filter visitors'
				empty={<EmptyState {...empty} />}
				detail={{
					openId: open,
					onOpenChange: setOpen,
					title: row => row.visitor,
					description: row => [place(row), device(row)].filter(Boolean).join(' · '),
					render: row => <Journey domainId={domainId} visitor={row.visitor} />,
				}}
			/>
			{/* The manager lists the newest 200 (insights.rs VISITOR_LIMIT) and counts them all. */}
			{total !== undefined && data.length < total ? (
				<p className='px-2 pt-3 text-xs text-muted'>The newest {data.length} are listed.</p>
			) : null}
			<GeoCredit />
		</Section>
	)
}

/** Everything one visitor did, oldest first, with each payment in its place. */
function Journey({ domainId, visitor }: { domainId: string; visitor: string }) {
	const journey = useQuery({
		queryKey: ['analytics', domainId, 'journey', visitor],
		queryFn: () => api.analyticsJourney(domainId, visitor),
	})
	if (!journey.data) {
		return journey.error ? <ErrorText error={journey.error} /> : <Skeleton label='Loading the journey' lines={4} />
	}

	const steps = [
		...journey.data.events.map(event => ({
			at: event.at,
			title: event.kind === 'goal' ? `Goal ${event.name}` : event.path,
			detail:
				event.kind === 'goal'
					? event.props
					: [event.referrer || event.utm_source, event.city || event.location, event.device]
							.filter(Boolean)
							.join(' · '),
		})),
		...journey.data.payments.map(payment => ({
			at: payment.at,
			title: `Paid ${moneyFormat(payment.currency)?.(payment.amount) ?? payment.amount}`,
			detail: payment.payment_id,
		})),
	].toSorted((a, b) => a.at - b.at)

	return (
		<Timeline
			label={`Journey of ${visitor}`}
			steps={steps.map((step, index) => ({
				id: `${step.at}:${index}`,
				name: step.title,
				status: 'success',
				detail: [new Date(step.at * 1000).toLocaleString(), step.detail].filter(Boolean).join(' · '),
			}))}
		/>
	)
}
