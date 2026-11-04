import { useMemo } from 'react'
import { IconCoin, IconEye, IconTarget } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { GeoCredit, moneyFormat } from '../components/analytics-report'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { RelativeTime, Section, Status } from '../components/primitives'
import { type AnalyticsLive, api } from '../lib/api'

export const Route = createFileRoute('/analytics/$domainId/live')({ component: Live })

type Online = AnalyticsLive['online'][number]
type FeedItem = AnalyticsLive['feed'][number]

function onlineColumns(): Columns<Online> {
	const cell = columnsFor<Online>()
	return [
		cell.accessor('path', { header: 'Page', meta: { mono: true } }),
		cell.accessor(row => row.referrer || row.channel, { id: 'source', header: 'Source' }),
		cell.accessor(row => [row.city, row.location].filter(Boolean).join(', '), { id: 'place', header: 'Location' }),
		cell.accessor(row => `${row.device}, ${row.browser}, ${row.os}`, { id: 'device', header: 'Device' }),
		cell.accessor('pageviews', { header: 'Pageviews', meta: { align: 'right', mono: true } }),
		cell.accessor('customer', {
			header: 'Customer',
			cell: ({ getValue }) => (getValue() ? <Status value='customer' /> : null),
		}),
		cell.accessor('last_seen', { header: 'Seen', cell: ({ getValue }) => <RelativeTime at={getValue()} /> }),
	]
}

const feedIcon = { pageview: IconEye, goal: IconTarget, payment: IconCoin } as const

function feedColumns(): Columns<FeedItem> {
	const cell = columnsFor<FeedItem>()
	return [
		cell.accessor('kind', {
			header: 'What',
			cell: ({ row }) => {
				const { kind } = row.original
				const Icon = kind === 'goal' || kind === 'payment' ? feedIcon[kind] : feedIcon.pageview
				return (
					<span className='inline-flex items-center gap-2'>
						<Icon size={16} stroke={1.75} className='text-muted' />
						{kind}
					</span>
				)
			},
		}),
		cell.accessor('detail', {
			header: 'Detail',
			cell: ({ row }) => {
				const item = row.original
				if (item.kind !== 'payment') return <span className='font-mono text-xs'>{item.detail}</span>
				const money = moneyFormat(item.currency)
				return <span className='text-success'>{money ? money(Number(item.detail)) : item.detail}</span>
			},
		}),
		cell.accessor('location', { header: 'Location' }),
		cell.accessor('visitor', { header: 'Visitor', meta: { mono: true } }),
		cell.accessor('at', { header: 'When', cell: ({ getValue }) => <RelativeTime at={getValue()} /> }),
	]
}

function Live() {
	const { domainId } = Route.useParams()
	const live = useQuery({
		queryKey: ['analytics', domainId, 'live'],
		queryFn: () => api.analyticsLive(domainId),
		refetchInterval: 5000,
	})
	const online = useMemo(onlineColumns, [])
	const feed = useMemo(feedColumns, [])

	return (
		<div className='flex flex-col gap-4'>
			<Section title='Online now' total={live.data?.online.length ?? 0}>
				<DataTable
					data={live.data?.online ?? []}
					columns={online}
					loading={live.isLoading}
					error={live.error}
					getRowId={row => row.visitor}
					empty='Nobody on the site in the last 3 minutes.'
				/>
			</Section>
			<Section title='Last 30 minutes' total={live.data?.feed.length ?? 0}>
				<DataTable
					data={live.data?.feed ?? []}
					columns={feed}
					loading={live.isLoading}
					getRowId={(row, index) => `${row.at}:${row.visitor}:${index}`}
					empty='No pageviews, goals or payments in the last 30 minutes.'
				/>
				<GeoCredit />
			</Section>
		</div>
	)
}
