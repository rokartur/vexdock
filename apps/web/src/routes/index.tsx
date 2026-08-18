import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { MetricCard, seriesOf, useHistory } from '../components/metric-chart'
import { Page, Refresh, Section, Status } from '../components/primitives'
import { api, type HostPoint, type HostStats, type SystemInfo } from '../lib/api'
import { bytes, duration, percent, shortSha, since } from '../lib/format'
import { useEventSource } from '../lib/sse'

type RecentDeployment = SystemInfo['recent_deployments'][number]

/** Recorded buckets are stamped in unix seconds; live samples use the browser clock. */
const toMillis = (point: HostPoint): HostPoint => ({ ...point, at: point.at * 1000 })

const deploymentColumns: Columns<RecentDeployment> = (() => {
	const cell = columnsFor<RecentDeployment>()
	return [
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
		cell.accessor(({ deployment }) => deployment.branch, { id: 'branch', header: 'Branch', meta: { mono: true } }),
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
					#{original.deployment.number} {shortSha(original.deployment.commit_sha)}
				</Link>
			),
		}),
		cell.accessor(({ deployment }) => deployment.trigger, { id: 'trigger', header: 'Trigger' }),
		cell.accessor(({ deployment }) => deployment.status, {
			id: 'status',
			header: 'Status',
			cell: ({ row }) => <Status value={row.original.deployment.status} />,
		}),
		cell.accessor(({ deployment }) => deployment.started_at ?? '', {
			id: 'duration',
			header: 'Duration',
			meta: { mono: true },
			cell: ({ row: { original } }) => duration(original.deployment.started_at, original.deployment.finished_at),
		}),
		cell.accessor(({ deployment }) => deployment.created_at, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => since(row.original.deployment.created_at),
		}),
	]
})()

export const Route = createFileRoute('/')({ component: DashboardPage })

function DashboardPage() {
	const info = useQuery({ queryKey: ['system', 'info'], queryFn: api.systemInfo, refetchInterval: 15_000 })
	const recorded = useQuery({ queryKey: ['system', 'metrics'], queryFn: () => api.systemMetrics('30m') })
	const [stats, setStats] = useState<HostPoint | null>(null)

	useEventSource('/api/system/stats', {
		stats: data => setStats({ ...(data as HostStats), at: Date.now() }),
	})

	const history = useHistory(
		stats,
		useMemo(() => (recorded.data ?? []).map(toMillis), [recorded.data]),
	)
	// Until the first live sample lands, the newest recorded bucket is the reading.
	const current = stats ?? history.at(-1)
	const diskUsed = current && current.disk_total > 0 ? current.disk_used / current.disk_total : 0

	return (
		<Page>
			<Section title='System'>
				<div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-4'>
					<MetricCard
						label='CPU'
						value={current ? percent(current.cpu_percent) : '-'}
						series={[seriesOf(history, sample => sample.cpu_percent)]}
						max={100}
						format={([cpu]) => percent(cpu)}
					/>
					<MetricCard
						label='RAM'
						value={
							current && current.memory_total > 0
								? `${bytes(current.memory_used)} / ${bytes(current.memory_total)}`
								: bytes(info.data?.host.memory_total)
						}
						series={[seriesOf(history, sample => sample.memory_used)]}
						max={current?.memory_total}
						format={([used]) => `${bytes(used)} / ${bytes(current?.memory_total)}`}
					/>
					{/* Disk moves in hours, so a line would be flat; the bar says more. */}
					<div className='rounded-md border px-2.5 py-2'>
						<div className='text-meta tracking-wide text-muted-foreground uppercase'>Disk</div>
						<div className='font-mono text-title'>
							{current && current.disk_total > 0
								? `${bytes(current.disk_used)} / ${bytes(current.disk_total)}`
								: '-'}
						</div>
						<div className='mt-3 h-1 rounded-full bg-muted'>
							<div
								className='h-full rounded-full bg-foreground'
								style={{ width: percent(diskUsed * 100) }}
							/>
						</div>
						<div className='mt-1.5 font-mono text-meta text-muted-foreground'>
							{percent(diskUsed * 100)} used
						</div>
					</div>
					<div className='rounded-md border px-2.5 py-2'>
						<div className='text-meta tracking-wide text-muted-foreground uppercase'>Platform</div>
						<dl className='mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-body'>
							<dt className='text-muted-foreground'>Projects</dt>
							<dd className='text-right font-mono'>{info.data?.projects ?? 0}</dd>
							<dt className='text-muted-foreground'>Containers</dt>
							<dd className='text-right font-mono'>
								{info.data?.containers_running ?? 0} / {info.data?.containers ?? 0}
							</dd>
							<dt className='text-muted-foreground'>Images</dt>
							<dd className='text-right font-mono'>{info.data?.images ?? 0}</dd>
						</dl>
					</div>
				</div>
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
