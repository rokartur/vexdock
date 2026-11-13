import { useMemo } from 'react'
import { IconChevronDown, IconChevronRight, IconFolder, IconWorld } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Sparkline } from '@/components/ui/sparkline'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, EmptyState, IconButton, Page, Refresh, Section, StatStrip, textLink } from '../components/primitives'
import { analyticsSitesQuery, preload } from '../lib/queries'
import { groupSites, type SiteRow } from '../lib/site-groups'

export const Route = createFileRoute('/analytics/')({
	loader: ({ context: { queryClient } }) => preload(queryClient, analyticsSitesQuery),
	component: AnalyticsSites,
})

function siteColumns(): Columns<SiteRow> {
	const cell = columnsFor<SiteRow>()
	return [
		cell.accessor(site => site.domain.hostname, {
			id: 'site',
			header: 'Site',
			cell: ({ row }) => {
				const { domain, subdomains = [] } = row.original
				const parent = row.getParentRow()?.original.domain.hostname
				const open = row.getIsExpanded()
				return (
					<div className={cn('flex items-center gap-2', parent && 'pl-9')}>
						{parent ? null : subdomains.length > 0 ? (
							<IconButton
								icon={open ? IconChevronDown : IconChevronRight}
								label={open ? 'Hide subdomains' : 'Show subdomains'}
								aria-expanded={open}
								onClick={() => row.toggleExpanded()}
							/>
						) : (
							<span className='w-7' />
						)}
						<Link
							to='/analytics/$domainId'
							params={{ domainId: domain.id }}
							tabIndex={-1}
							className={cn(textLink, 'inline-flex items-center gap-2')}
						>
							{parent ? (
								<span>
									{domain.hostname.slice(0, -parent.length - 1)}
									<span className='text-muted'>.{parent}</span>
								</span>
							) : (
								<>
									<IconWorld stroke={1.75} className='size-4 text-muted' />
									{domain.hostname}
								</>
							)}
						</Link>
						{subdomains.length > 0 ? (
							<Badge size='sm'>
								+{subdomains.length} {subdomains.length === 1 ? 'subdomain' : 'subdomains'}
							</Badge>
						) : null}
					</div>
				)
			},
		}),
		cell.accessor(site => site.visitors, {
			id: 'visitors',
			header: 'Visitors, 24h',
			meta: { align: 'right', mono: true },
			cell: ({ getValue }) => getValue().toLocaleString('en-US'),
		}),
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
	const groups = useMemo(() => groupSites(sites.data ?? []), [sites.data])
	const columns = useMemo(siteColumns, [])
	let visitors = 0
	for (const site of data) visitors += site.visitors

	return (
		<Page fill>
			{data.length > 0 ? (
				<StatStrip
					className='mb-4'
					items={[{ label: 'Visitors, 24h', value: visitors.toLocaleString('en-US') }]}
				/>
			) : null}
			<Section
				title='Sites'
				total={sites.data?.length}
				fill
				actions={<Refresh onClick={() => sites.refetch()} />}
			>
				<DataTable
					data={groups}
					columns={columns}
					getSubRows={site => site.subdomains}
					loading={sites.isLoading}
					error={sites.error}
					getRowId={site => site.domain.id}
					filter='Filter sites'
					empty={
						<EmptyState
							title='No domains yet'
							description='Add one to a service and its visits show up here.'
						>
							<Button render={<Link to='/projects' />}>
								<IconFolder size={16} stroke={1.75} />
								Open projects
							</Button>
						</EmptyState>
					}
					onRowClick={site => navigate({ to: '/analytics/$domainId', params: { domainId: site.domain.id } })}
				/>
			</Section>
		</Page>
	)
}
