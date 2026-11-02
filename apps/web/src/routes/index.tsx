import { useMemo, useState } from 'react'
import { IconCertificate, IconFolder, IconPlayerPlay, IconServer, IconStack2, IconTag } from '@tabler/icons-react'
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { DeploymentDetail } from '../components/deployment-detail'
import { HostMetrics, WINDOWS } from '../components/host-metrics'
import { useHistory } from '../components/metric-chart'
import { Cell, Cells, Page, Refresh, RelativeTime, Section, Status } from '../components/primitives'
import {
	api,
	type Certificate,
	type HostPoint,
	type HostStats,
	type MetricWindow,
	type Project,
	type SystemInfo,
} from '../lib/api'
import { until } from '../lib/format'
import { certificatesQuery, preload, projectsQuery, systemInfoQuery, versionQuery } from '../lib/queries'
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

const metricsQuery = (window: MetricWindow) =>
	queryOptions({
		queryKey: ['system', 'metrics', window],
		queryFn: () => api.systemMetrics(window),
		placeholderData: keepPreviousData,
	})

export const Route = createFileRoute('/')({
	loader: ({ context: { queryClient } }) =>
		Promise.all([
			preload(queryClient, systemInfoQuery),
			preload(queryClient, metricsQuery('30m')),
			preload(queryClient, versionQuery),
			preload(queryClient, certificatesQuery),
		]),
	component: DashboardPage,
})

function DashboardPage() {
	const info = useQuery(systemInfoQuery)
	const [window, setWindow] = useState<MetricWindow>('30m')
	const recorded = useQuery(metricsQuery(window))
	const version = useQuery(versionQuery)
	const projects = useQuery(projectsQuery)
	const certificates = useQuery(certificatesQuery)
	const [stats, setStats] = useState<HostSample | null>(null)
	const [openDeployment, setOpenDeployment] = useState<string | null>(null)

	useEventSource('/api/system/stats', {
		stats: data => setStats({ ...(data as HostStats), at: Date.now() }),
	})

	const history = useHistory(
		stats,
		useMemo(() => (recorded.data ?? []).map(toMillis), [recorded.data]),
		WINDOWS.find(option => option.value === window)?.ms,
	)
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
				<Section title='Needs attention' total={concerns.length}>
					<ul className='divide-y divide-border-subtle rounded-surface border bg-surface'>
						{concerns.map(concern => (
							<li key={concern.id}>
								<Link
									to={concern.to}
									className='flex items-center gap-3 px-4 py-2.5 hover:bg-surface-muted'
								>
									<Status dot value={concern.state} />
									<span className='font-mono text-sm'>{concern.subject}</span>
									<span className='truncate text-xs text-muted'>{concern.detail}</span>
								</Link>
							</li>
						))}
					</ul>
				</Section>
			) : null}

			<HostMetrics history={history} window={window} onWindowChange={setWindow} load={stats?.load_average} />

			<Section title='Fleet'>
				<Cells className='grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]'>
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
						hint={
							[
								`${services.apps} app${services.apps === 1 ? '' : 's'}`,
								`${services.compose} compose`,
								`${services.db} db`,
							]
								.filter(part => !part.startsWith('0 '))
								.join(' · ') || 'none yet'
						}
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
									className='text-warning underline-offset-4 hover:underline'
								>
									{info.data?.version}
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
				/>
			</Section>
		</Page>
	)
}
