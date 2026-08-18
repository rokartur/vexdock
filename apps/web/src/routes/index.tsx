import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { MetricCard, seriesOf, useHistory } from '../components/metric-chart'
import { Page, Refresh, Section, Status } from '../components/primitives'
import { api, type HostPoint, type HostStats, type SystemInfo } from '../lib/api'
import { bytes, percent, since } from '../lib/format'
import { useEventSource } from '../lib/sse'

type RecentDeployment = SystemInfo['recent_deployments'][number]


const deploymentColumns: Columns<RecentDeployment> = (() => {
	const cell = columnsFor<RecentDeployment>()
	return [
		cell.accessor(({ deployment }) => deployment.status, {
			id: 'status',
			header: '',
			cell: ({ row }) => <Status value={row.original.deployment.status} />,
		}),
		cell.accessor(({ deployment, project_name }) => project_name || deployment.project_id, {
			id: 'project',
			header: 'Project',
			cell: ({ row: { original } }) => (
				<Link
					to='/projects/$projectId'
					params={{ projectId: original.deployment.project_id }}
					className='hover:underline'
				>
					{original.project_name || original.deployment.project_id}
				</Link>
			),
		}),
		cell.accessor(({ deployment }) => deployment.number, {
			id: 'commit',
			header: 'Commit',
			meta: { mono: true },
			cell: ({ row: { original } }) => (
				<Link
					to='/deployments/$deploymentId'
					params={{ deploymentId: original.deployment.id }}
					className='hover:underline'
				>
					#{original.deployment.number} {original.deployment.commit_sha.slice(0, 7)}
				</Link>
			),
		}),
		cell.accessor(({ deployment }) => deployment.trigger, { id: 'trigger', header: 'Trigger' }),
		cell.accessor(({ deployment }) => deployment.created_at, {
			id: 'when',
			header: 'When',
			cell: ({ row }) => since(row.original.deployment.created_at),
		}),
	]
})()

export const Route = createFileRoute('/')({ component: DashboardPage })

function DashboardPage() {
	const info = useQuery({ queryKey: ['system', 'info'], queryFn: api.systemInfo, refetchInterval: 15_000 })
	const [stats, setStats] = useState<HostStats | null>(null)

	useEventSource('/api/system/stats', {
		stats: data => setStats(data as HostStats),
	})

	return (
		<Page title='Dashboard'>
			<Section title='System'>
				<dl className='grid grid-cols-2 gap-x-8 gap-y-1 border-t border-border pt-2 sm:grid-cols-3 lg:grid-cols-6'>
					<Metric label='CPU' value={stats ? percent(stats.cpu_percent) : '-'} />
					<Metric
						label='RAM'
						value={
							stats && stats.memory_total > 0
								? `${bytes(stats.memory_used)} / ${bytes(stats.memory_total)}`
								: bytes(info.data?.host.memory_total)
						}
					/>
					<Metric
						label='Disk'
						value={
							stats && stats.disk_total > 0
								? `${bytes(stats.disk_used)} / ${bytes(stats.disk_total)}`
								: '-'
						}
					/>
					<Metric label='Projects' value={String(info.data?.projects ?? 0)} />
					<Metric
						label='Containers'
						value={`${info.data?.containers_running ?? 0} / ${info.data?.containers ?? 0}`}
					/>
					<Metric label='Images' value={String(info.data?.images ?? 0)} />
				</dl>
			</Section>

			<Section
				title='Deployments'
				description='most recent across all projects'
				actions={<Refresh onClick={() => info.refetch()} busy={info.isFetching} />}
			>
				<DataTable
					data={info.data?.recent_deployments ?? []}
					columns={deploymentColumns}
					loading={info.isLoading}
					getRowId={({ deployment }) => deployment.id}
					empty={
						<>
							No deployments yet.{' '}
							<Link to='/projects' className='underline'>
								Create a project
							</Link>{' '}
							to get started.
						</>
					}
				/>
			</Section>
		</Page>
	)
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className='py-1'>
			<dt className='text-[12px] tracking-wide text-muted-foreground uppercase'>{label}</dt>
			<dd className='font-mono text-[14px]'>{value}</dd>
		</div>
	)
}
