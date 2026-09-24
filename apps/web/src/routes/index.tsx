import { useMemo, useState } from 'react'
import {
	IconCertificate,
	IconCpu,
	IconDatabase,
	IconFolder,
	IconPlayerPlay,
	IconServer,
	IconStack2,
	IconTag,
} from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { DeploymentDetail } from '../components/deployment-detail'
import { MetricCard, seriesOf, useHistory } from '../components/metric-chart'
import { Cell, Cells, Meter, Page, Refresh, RelativeTime, Section, Status } from '../components/primitives'
import { api, type Certificate, type HostPoint, type HostStats, type Project, type SystemInfo } from '../lib/api'
import { bytes, percent, until } from '../lib/format'
import { useEventSource } from '../lib/sse'

/** The live stream carries a load average the recorded buckets do not. */
type HostSample = HostPoint & { load_average?: number }

/** Close enough to expiry that a renewal which has not happened yet is worth reading as a problem. */
const EXPIRY_WARNING_DAYS = 21

type Concern = { id: string; state: string; subject: string; detail: string; to: string }

/** The two things on this page that are wrong rather than merely notable: services Docker gave up on, and certificates running out. */
function concernsOf(projects: Project[], certificates: Certificate[]): Concern[] {
	const deadline = Date.now() + EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000
	const concerns: Concern[] = []
	for (const project of projects) {
		if (project.errored_count > 0) {
			concerns.push({
				id: project.id,
				state: 'failed',
				subject: project.name,
				detail: `${project.errored_count} of ${project.service_count} services errored`,
				to: `/projects/${project.id}`,
			})
		}
	}
	for (const certificate of certificates) {
		const expiry = Date.parse(certificate.expires_at)
		const expiring = !Number.isNaN(expiry) && expiry < deadline
		if (certificate.status === 'failed' || expiring) {
			concerns.push({
				id: certificate.id,
				state: certificate.status === 'failed' ? 'failed' : 'pending',
				subject: certificate.hostname,
				detail:
					certificate.status === 'failed'
						? certificate.last_error || 'certificate could not be issued'
						: `certificate expires ${until(certificate.expires_at)}`,
				to: '/system/certificates',
			})
		}
	}
	return concerns
}

/** Recorded buckets are stamped in unix seconds; live samples use the browser clock. */
const toMillis = (point: HostPoint): HostSample => ({ ...point, at: point.at * 1000 })

type RecentDeployment = SystemInfo['recent_deployments'][number]

const renderDeploymentDetail = ({ deployment }: RecentDeployment) => <DeploymentDetail deploymentId={deployment.id} />
const deploymentDetailTitle = ({ deployment, project_name }: RecentDeployment) =>
	`${project_name || deployment.project_id} / ${deployment.service_name} #${deployment.number}`

// One machine runs everything, so the server column is the Docker host's name.
function recentDeploymentColumns(server: string): Columns<RecentDeployment> {
	const cell = columnsFor<RecentDeployment>()
	return [
		cell.accessor(({ deployment }) => deployment.status, {
			id: 'status',
			header: 'Status',
			cell: ({ row }) => <Status value={row.original.deployment.status} />,
		}),
		cell.accessor(({ deployment }) => deployment.service_name, {
			id: 'service',
			header: 'Service',
			meta: { mono: true },
		}),
		cell.accessor(({ deployment, project_name }) => project_name || deployment.project_id, {
			id: 'project',
			header: 'Project',
		}),
		cell.accessor(({ environment_name }) => environment_name, { id: 'environment', header: 'Environment' }),
		cell.display({ id: 'server', header: 'Server', meta: { mono: true }, cell: () => server }),
		cell.accessor(({ deployment }) => deployment.created_at, {
			id: 'when',
			header: 'When',
			cell: ({ row }) => <RelativeTime at={row.original.deployment.created_at} />,
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
	// Same key the certificates page uses.
	const certificates = useQuery({ queryKey: ['certificates'], queryFn: api.certificates })
	const [stats, setStats] = useState<HostSample | null>(null)
	const [openDeployment, setOpenDeployment] = useState<string | null>(null)

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
	const concerns = useMemo(
		() => concernsOf(projects.data ?? [], certificates.data ?? []),
		[projects.data, certificates.data],
	)
	const nextExpiry = (certificates.data ?? [])
		.map(certificate => certificate.expires_at)
		.toSorted()
		.at(0)

	// The page fits the window and the deployments take what is left, so only that list scrolls.
	return (
		<Page fill>
			{concerns.length > 0 ? (
				<Section title='Needs attention' description={`${concerns.length} open`}>
					<ul className='divide-y divide-rule rounded-xl border bg-card raised'>
						{concerns.map(concern => (
							<li key={concern.id}>
								<Link
									to={concern.to}
									className='flex items-center gap-3 px-4 py-2.5 hover:bg-accent/40'
								>
									<Status dot value={concern.state} />
									<span className='font-mono text-body'>{concern.subject}</span>
									<span className='truncate text-label text-muted-foreground'>{concern.detail}</span>
								</Link>
							</li>
						))}
					</ul>
				</Section>
			) : null}

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
						<Meter
							className='mt-2.5'
							label=''
							value={current?.disk_used ?? 0}
							max={current?.disk_total ?? 0}
						/>
					</Cell>
					<Cell
						label='Certificates'
						icon={IconCertificate}
						value={certificates.data?.length ?? 0}
						hint={nextExpiry ? `next renewal ${until(nextExpiry)}` : 'none issued'}
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
				fill
				actions={<Refresh onClick={() => info.refetch()} busy={info.isFetching} />}
			>
				<DataTable
					data={deployments}
					columns={deploymentColumns}
					loading={info.isLoading}
					error={info.error}
					getRowId={({ deployment }) => deployment.id}
					detail={{
						openId: openDeployment,
						onOpenChange: setOpenDeployment,
						title: deploymentDetailTitle,
						render: renderDeploymentDetail,
					}}
					empty='No deployments yet'
					fill
				/>
			</Section>
		</Page>
	)
}
