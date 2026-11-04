import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { GeoCredit, moneyFormat } from '../components/analytics-report'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { ErrorText, RelativeTime, Section, Timeline } from '../components/primitives'
import { type AnalyticsVisitor, api } from '../lib/api'
import { useSpan } from './analytics.$domainId'

export const Route = createFileRoute('/analytics/$domainId/visitors')({ component: Visitors })

function visitorColumns(): Columns<AnalyticsVisitor> {
	const cell = columnsFor<AnalyticsVisitor>()
	return [
		cell.accessor('visitor', { header: 'Visitor', meta: { mono: true } }),
		cell.accessor(row => row.referrer || row.channel, { id: 'source', header: 'Source' }),
		cell.accessor(row => [row.city, row.location].filter(Boolean).join(', '), { id: 'place', header: 'Location' }),
		cell.accessor(row => `${row.device}, ${row.browser}, ${row.os}`, { id: 'device', header: 'Device' }),
		cell.accessor('sessions', { header: 'Sessions', meta: { align: 'right', mono: true } }),
		cell.accessor('pageviews', { header: 'Pageviews', meta: { align: 'right', mono: true } }),
		cell.accessor('goals', { header: 'Goals', meta: { align: 'right', mono: true } }),
		cell.accessor('revenue', {
			header: 'Revenue',
			meta: { align: 'right', mono: true },
			cell: ({ row }) => {
				const money = moneyFormat(row.original.currency)
				return money && row.original.revenue > 0 ? (
					<span className='text-success'>{money(row.original.revenue)}</span>
				) : null
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

	return (
		<Section title='Visitors' total={visitors.data?.total ?? 0}>
			<DataTable
				data={data}
				columns={columns}
				loading={visitors.isLoading}
				error={visitors.error}
				getRowId={row => row.visitor}
				filter='Filter visitors'
				empty='No visitors in this range.'
				detail={{
					openId: open,
					onOpenChange: setOpen,
					title: row => `Visitor ${row.visitor}`,
					render: row => <Journey domainId={domainId} visitor={row.visitor} />,
				}}
			/>
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
	if (!journey.data) return <ErrorText error={journey.error} />

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
