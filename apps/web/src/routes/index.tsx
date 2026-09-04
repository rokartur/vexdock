import { useMemo, useState } from 'react'
import {
	IconBox,
	IconCpu,
	IconDatabase,
	IconFileText,
	IconFolder,
	IconPlayerPlay,
	IconServer,
	IconStack2,
	IconTag,
} from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Progress } from '@/components/ui/progress'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { MetricCard, seriesOf, useHistory } from '../components/metric-chart'
import { Cell, Cells, IconButton, Page, Refresh, Section, Status } from '../components/primitives'
import { api, type HostPoint, type HostStats, type SystemInfo } from '../lib/api'
import { deploymentLink } from '../lib/deployment-link'
import { bytes, percent, since } from '../lib/format'
import { useEventSource } from '../lib/sse'

/** The live stream carries a load average the recorded buckets do not. */
type HostSample = HostPoint & { load_average?: number }

/** Recorded buckets are stamped in unix seconds; live samples use the browser clock. */
const toMillis = (point: HostPoint): HostSample => ({ ...point, at: point.at * 1000 })

type RecentDeployment = SystemInfo['recent_deployments'][number]

// One machine runs everything, so the server column is the Docker host's name.
function recentDeploymentColumns(server: string): Columns<RecentDeployment> {
	const cell = columnsFor<RecentDeployment>()
	return [
		cell.accessor(({ deployment }) => deployment.status, {
			id: 'status',
			header: 'Status',
			cell: ({ row }) => <Status value={row.original.deployment.status} />,
		}),
		// An unscoped deploy covers every service in the environment, so name them
		// rather than printing "all".
		cell.accessor(
			({ deployment, environment_services }) =>
				deployment.service_name || environment_services.join(', ') || 'all',
			{ id: 'service', header: 'Service', meta: { mono: true } },
		),
		cell.accessor(({ deployment, project_name }) => project_name || deployment.project_id, {
			id: 'project',
			header: 'Project',
		}),
		cell.accessor(({ environment_name }) => environment_name, { id: 'environment', header: 'Environment' }),
		cell.display({ id: 'server', header: 'Server', meta: { mono: true }, cell: () => server }),
		cell.accessor(({ deployment }) => deployment.created_at, {
			id: 'when',
			header: 'When',
			cell: ({ row }) => (
				<span className='text-muted-foreground'>{since(row.original.deployment.created_at)}</span>
			),
		}),
		cell.display({
			id: 'logs',
			header: '',
			meta: { align: 'right' },
			cell: ({ row: { original } }) => (
				<IconButton
					icon={IconFileText}
					label='Logs'
					render={<Link {...deploymentLink(original.deployment.project_id, original.deployment.id)} />}
				/>
			),
		}),
	]
}

export const Route = createFileRoute('/')({ component: DashboardPage })

function DashboardPage() {
	const info = useQuery({ queryKey: ['system', 'info'], queryFn: api.systemInfo })
	const recorded = useQuery({ queryKey: ['system', 'metrics'], queryFn: () => api.systemMetrics('30m') })
	// Same key the shell uses, so this rides its cache instead of re-fetching.
	const version = useQuery({ queryKey: ['version'], queryFn: api.version })
	// Same key the projects page uses.
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
	const [stats, setStats] = useState<HostSample | null>(null)

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
	const host = info.data?.host

	// Every card already carries its own counts, so the fleet totals are a sum.
	const services = useMemo(() => {
		const totals = { total: 0, running: 0, errored: 0, db: 0, compose: 0 }
		for (const project of projects.data ?? []) {
			totals.total += project.service_count
			totals.running += project.running_count
			totals.errored += project.errored_count
			totals.db += project.database_count
			totals.compose += project.compose_count
		}
		return {
			...totals,
			// What Docker is neither running nor failing on is idle: stopped,
			// paused, or never deployed. What is neither a database nor declared by
			// a compose file is an application.
			idle: Math.max(totals.total - totals.running - totals.errored, 0),
			apps: Math.max(totals.total - totals.db - totals.compose, 0),
		}
	}, [projects.data])

	// The API already returns these newest-first, capped.
	const deployments = info.data?.recent_deployments ?? []
	const deploymentColumns = useMemo(() => recentDeploymentColumns(host?.name ?? ''), [host?.name])

	return (
		<Page
			actions={
				host ? (
					<span className='truncate text-meta text-muted-foreground'>
						{[
							host.name,
							`${host.os}/${host.architecture}`,
							`${host.cpus} vCPU`,
							bytes(host.memory_total),
							`docker ${host.docker_version}`,
						].join(' · ')}
					</span>
				) : null
			}
		>
			<Section title='Host' description='live, 30m history'>
				{/* A host is judged on cpu and memory, so on the fleet page those two get
				    a row to themselves and a chart big enough to read a trend off. */}
				<Cells className='mb-2'>
					<MetricCard
						label='CPU'
						icon={IconCpu}
						value={current ? percent(current.cpu_percent) : '-'}
						series={[seriesOf(history, sample => sample.cpu_percent)]}
						max={100}
						format={([cpu]) => percent(cpu)}
						hint={stats?.load_average === undefined ? undefined : `load ${stats.load_average.toFixed(2)}`}
						height={96}
					/>
					<MetricCard
						label='Memory'
						icon={IconServer}
						value={current ? bytes(current.memory_used) : '-'}
						series={[seriesOf(history, sample => sample.memory_used)]}
						max={current?.memory_total}
						format={([used]) => bytes(used)}
						hint={`of ${bytes(current?.memory_total ?? host?.memory_total)}`}
						height={96}
					/>
				</Cells>
				<Cells>
					{/* Disk moves in hours, so a line would be flat; the bar says more. */}
					<Cell
						label='Disk'
						icon={IconDatabase}
						value={current ? bytes(current.disk_used) : '-'}
						hint={`of ${bytes(current?.disk_total)} · ${percent(diskUsed * 100)}`}
					>
						<Progress value={diskUsed * 100} className='mt-2.5 h-0.5' />
					</Cell>
					<Cell
						label='Containers'
						icon={IconBox}
						value={`${info.data?.containers_running ?? 0} / ${info.data?.containers ?? 0}`}
						hint='running / total'
					/>
					<Cell label='Projects' icon={IconFolder} value={projects.data?.length ?? 0} hint='on this host' />
					<Cell
						label='Services'
						icon={IconServer}
						value={services.total}
						hint={`${services.apps} apps · ${services.compose} compose · ${services.db} db`}
					/>
					<Cell
						label='Running'
						icon={IconPlayerPlay}
						value={`${services.running} / ${services.total}`}
						hint={`${services.errored} errored · ${services.idle} idle`}
					/>
					<Cell label='Images' icon={IconStack2} value={info.data?.images ?? 0} hint='on this host' />
					<Cell
						label='Version'
						icon={IconTag}
						value={
							version.data?.update_available ? (
								<Link
									to='/system/settings/about'
									className='text-amber-400 underline-offset-4 hover:underline'
								>
									{info.data?.version} · update
								</Link>
							) : (
								(info.data?.version ?? '-')
							)
						}
						hint={version.data?.update_available ? 'update available' : 'up to date'}
					/>
				</Cells>
			</Section>

			<Section
				title='Deployments'
				description='newest first across every project'
				actions={<Refresh onClick={() => info.refetch()} busy={info.isFetching} />}
			>
				<DataTable
					data={deployments}
					columns={deploymentColumns}
					loading={info.isLoading}
					getRowId={({ deployment }) => deployment.id}
					empty='No deployments yet'
				/>
			</Section>
		</Page>
	)
}
