import { useMemo } from 'react'
import { IconWorld } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Sparkline } from '@/components/ui/sparkline'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Page, Refresh, Section, StatStrip } from '../components/primitives'
import type { AnalyticsSite } from '../lib/api'
import { analyticsSitesQuery, preload } from '../lib/queries'

export const Route = createFileRoute('/analytics/')({
	loader: ({ context: { queryClient } }) => preload(queryClient, analyticsSitesQuery),
	component: AnalyticsSites,
})

function siteColumns(): Columns<AnalyticsSite> {
	const cell = columnsFor<AnalyticsSite>()
	return [
		cell.accessor(site => site.domain.hostname, {
			id: 'site',
			header: 'Site',
			cell: ({ row }) => (
				<Link
					to='/analytics/$domainId'
					params={{ domainId: row.original.domain.id }}
					className='inline-flex items-center gap-2 underline-offset-2 hover:underline'
				>
					<IconWorld stroke={1.75} className='size-4 text-muted' />
					{row.original.domain.hostname}
				</Link>
			),
		}),
		cell.accessor(site => site.visitors, { id: 'visitors', header: 'Visitors, 24h', meta: { mono: true } }),
		cell.display({
			id: 'trend',
			header: 'Last 24 hours',
			cell: ({ row }) => (
				<div className='w-40'>
					<Sparkline
						label={`${row.original.domain.hostname} visitors per hour`}
						data={row.original.hourly}
						width={160}
						height={16}
						area={false}
						caption={false}
						interactive={false}
					/>
				</div>
			),
		}),
	]
}

function AnalyticsSites() {
	const navigate = useNavigate()
	const sites = useQuery(analyticsSitesQuery)
	const data = sites.data ?? []
	const columns = useMemo(siteColumns, [])
	let visitors = 0
	for (const site of data) visitors += site.visitors

	return (
		<Page fill>
			{data.length > 0 ? (
				<StatStrip
					className='mb-4'
					items={[
						{ label: 'Sites', value: data.length },
						{ label: 'Visitors, 24h', value: visitors.toLocaleString() },
					]}
				/>
			) : null}
			<Section
				title='Sites'
				total={data.length}
				fill
				actions={<Refresh onClick={() => sites.refetch()} busy={sites.isFetching} />}
			>
				<DataTable
					data={data}
					columns={columns}
					loading={sites.isLoading}
					error={sites.error}
					getRowId={site => site.domain.id}
					filter='Filter sites'
					empty='No domains yet. Add one to a service and its visits show up here.'
					onRowClick={site => navigate({ to: '/analytics/$domainId', params: { domainId: site.domain.id } })}
				/>
			</Section>
		</Page>
	)
}
