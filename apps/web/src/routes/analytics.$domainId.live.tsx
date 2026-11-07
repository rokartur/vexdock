import { useMemo, useState } from 'react'
import { IconCoin, IconEye, IconPlayerPause, IconPlayerPlay, IconTarget } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { GeoCredit, moneyFormat } from '../components/analytics-report'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { ErrorText, IconButton, RelativeTime, Section, Status } from '../components/primitives'
import { type AnalyticsLive, api } from '../lib/api'

export const Route = createFileRoute('/analytics/$domainId/live')({ component: Live })

type Online = AnalyticsLive['online'][number]
type FeedItem = AnalyticsLive['feed'][number]
type FeedRow = FeedItem & { id: string }

function onlineColumns(): Columns<Online> {
	const cell = columnsFor<Online>()
	return [
		cell.accessor('path', { header: 'Page', meta: { mono: true } }),
		cell.accessor(row => row.referrer || row.channel, { id: 'source', header: 'Source' }),
		cell.accessor(row => [row.city, row.location].filter(Boolean).join(', ') || '-', {
			id: 'place',
			header: 'Location',
		}),
		cell.accessor(row => `${row.device}, ${row.browser}, ${row.os}`, { id: 'device', header: 'Device' }),
		cell.accessor('pageviews', {
			header: 'Pageviews',
			meta: { align: 'right', mono: true },
			cell: ({ getValue }) => getValue().toLocaleString('en-US'),
		}),
		cell.accessor('customer', {
			header: 'Customer',
			cell: ({ getValue }) => (getValue() ? <Status value='customer' /> : null),
		}),
		cell.accessor('last_seen', { header: 'Seen', cell: ({ getValue }) => <RelativeTime at={getValue()} /> }),
	]
}

const feedIcon = { pageview: IconEye, goal: IconTarget, payment: IconCoin } as const
const feedWord = { pageview: 'Pageview', goal: 'Goal', payment: 'Payment' } as const

function feedColumns(): Columns<FeedRow> {
	const cell = columnsFor<FeedRow>()
	return [
		cell.accessor('kind', {
			header: 'What',
			cell: ({ row }) => {
				const { kind } = row.original
				const known = kind === 'goal' || kind === 'payment' ? kind : 'pageview'
				const Icon = feedIcon[known]
				return (
					<span className='inline-flex items-center gap-2'>
						<Icon size={16} stroke={1.75} className='text-muted' />
						{feedWord[known]}
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
				return money ? money(Number(item.detail)) : item.detail
			},
		}),
		cell.accessor(row => row.location || '-', { id: 'location', header: 'Location' }),
		cell.accessor('visitor', { header: 'Visitor', meta: { mono: true } }),
		cell.accessor('at', { header: 'When', cell: ({ getValue }) => <RelativeTime at={getValue()} /> }),
	]
}

function Live() {
	const { domainId } = Route.useParams()
	const [paused, setPaused] = useState(false)
	const live = useQuery({
		queryKey: ['analytics', domainId, 'live'],
		queryFn: () => api.analyticsLive(domainId),
		refetchInterval: paused ? false : 5000,
		refetchOnWindowFocus: !paused,
	})
	const online = useMemo(onlineColumns, [])
	const feed = useMemo(feedColumns, [])
	const feedRows = useMemo(() => withStableIds(live.data?.feed ?? []), [live.data])

	// Both tables read one query, so a failed read is one alert, not two.
	if (live.error && !live.data) return <ErrorText error={live.error} />

	return (
		<>
			<ErrorText error={live.error} />
			<Section
				title='Online now'
				total={live.data?.online.length}
				actions={
					// WCAG 2.2.2: tables that refresh every 5s beside other content can be held still.
					<IconButton
						icon={paused ? IconPlayerPlay : IconPlayerPause}
						label={paused ? 'Resume live updates' : 'Pause live updates'}
						onClick={() => setPaused(!paused)}
					/>
				}
			>
				<DataTable
					data={live.data?.online ?? []}
					columns={online}
					loading={live.isLoading}
					getRowId={row => row.visitor}
					empty='Nobody on the site in the last 3 minutes'
				/>
			</Section>
			<Section title='Last 30 minutes' total={live.data?.feed.length} fill>
				<DataTable
					data={feedRows}
					columns={feed}
					loading={live.isLoading}
					getRowId={row => row.id}
					empty='No pageviews, goals or payments in the last 30 minutes'
				/>
				<GeoCredit />
			</Section>
		</>
	)
}

/** The feed is newest first and grows at the top, so ids count repeats from the oldest end and never shift on a poll. */
function withStableIds(items: FeedItem[]): FeedRow[] {
	const seen = new Map<string, number>()
	const rows: FeedRow[] = []
	for (const item of items.toReversed()) {
		const base = `${item.at}:${item.visitor}:${item.kind}:${item.detail}`
		const repeat = seen.get(base) ?? 0
		seen.set(base, repeat + 1)
		rows.push({ ...item, id: repeat === 0 ? base : `${base}:${repeat}` })
	}
	return rows.toReversed()
}
