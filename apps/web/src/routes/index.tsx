import { useMemo, useState } from 'react'
import { IconPlus } from '@tabler/icons-react'
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Alert } from '@/components/ui/alert'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { DeploymentDetail } from '../components/deployment-detail'
import { HostMetrics, WINDOWS } from '../components/host-metrics'
import { useHistory } from '../components/metric-chart'
import { NewProjectDialog } from '../components/new-project'
import { Button, Page, Refresh, RelativeTime, Section, Segmented, Status } from '../components/primitives'
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

const recentDeploymentColumns: Columns<RecentDeployment> = (() => {
	const cell = columnsFor<RecentDeployment>()
	return [
		cell.accessor(({ deployment }) => `${deployment.service_name} #${deployment.number}`, {
			id: 'deployment',
			header: 'Deployment',
			cell: ({ row: { original } }) => (
				<span className='flex min-w-0 items-center gap-2.5'>
					<Status dot value={original.deployment.status} />
					<span className='truncate'>
						<span className='font-mono'>
							{original.deployment.service_name} #{original.deployment.number}
						</span>{' '}
						<span className='text-muted'>
							{original.project_name || original.deployment.project_id} · {original.environment_name}
						</span>
					</span>
				</span>
			),
		}),
		cell.accessor(({ deployment }) => deployment.created_at, {
			id: 'when',
			header: 'When',
			cell: ({ row }) => <RelativeTime at={row.original.deployment.created_at} />,
		}),
	]
})()

const projectColumns: Columns<Project> = (() => {
	const cell = columnsFor<Project>()
	return [
		cell.accessor(project => project.name, {
			id: 'name',
			header: 'Project',
			cell: ({ row }) => <span className='font-medium'>{row.original.name}</span>,
		}),
		cell.accessor(project => project.running_count, {
			id: 'services',
			header: 'Services',
			cell: ({ row }) => <ServiceSquares project={row.original} />,
		}),
		cell.accessor(project => project.domains[0]?.hostname ?? '', {
			id: 'domains',
			header: 'Domains',
			meta: { mono: true },
			cell: ({ row: { original } }) => {
				const [first, ...rest] = original.domains
				if (!first) return <span className='text-muted'>-</span>
				return (
					<span className='text-secondary'>
						{first.hostname}
						{rest.length > 0 ? ` +${rest.length}` : ''}
					</span>
				)
			},
		}),
		cell.accessor(project => project.latest_deployment?.status ?? '', {
			id: 'latest',
			header: 'Latest deployment',
			cell: ({ row: { original } }) => {
				const latest = original.latest_deployment
				if (!latest) return <span className='text-muted'>never</span>
				return (
					<span className='flex items-center gap-2'>
						<Status value={latest.status} />
						<span className='font-mono'>
							{latest.service_name} #{latest.number}
						</span>
					</span>
				)
			},
		}),
		cell.accessor(project => project.latest_deployment?.created_at ?? '', {
			id: 'when',
			header: 'When',
			cell: ({ row }) => <RelativeTime at={row.original.latest_deployment?.created_at} />,
		}),
	]
})()

/** One square per service: running, errored, then idle, so a project's health reads without counting. */
function ServiceSquares({ project }: { project: Project }) {
	const idle = Math.max(project.service_count - project.running_count - project.errored_count, 0)
	const squares = [
		...Array.from({ length: project.running_count }, () => 'bg-success'),
		...Array.from({ length: project.errored_count }, () => 'bg-danger'),
		...Array.from({ length: idle }, () => 'bg-surface-pressed'),
	]
	if (squares.length === 0) return <span className='text-muted'>-</span>
	return (
		<span
			role='img'
			aria-label={`${project.running_count} running, ${project.errored_count} errored, ${idle} idle`}
			className='flex flex-wrap gap-0.75'
		>
			{squares.map((tone, index) => (
				// oxlint-disable-next-line react/no-array-index-key -- squares carry no identity, only a count
				<span key={index} className={`size-2.5 rounded-[3px] ${tone}`} />
			))}
		</span>
	)
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
	const navigate = useNavigate()
	const info = useQuery(systemInfoQuery)
	const [window, setWindow] = useState<MetricWindow>('30m')
	const recorded = useQuery(metricsQuery(window))
	const version = useQuery(versionQuery)
	const projects = useQuery(projectsQuery)
	const certificates = useQuery(certificatesQuery)
	const [stats, setStats] = useState<HostSample | null>(null)
	const [openDeployment, setOpenDeployment] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)

	useEventSource('/api/system/stats', {
		stats: data => setStats({ ...(data as HostStats), at: Date.now() }),
	})

	const history = useHistory(
		stats,
		useMemo(() => (recorded.data ?? []).map(toMillis), [recorded.data]),
		WINDOWS.find(option => option.value === window)?.ms,
	)
	const host = info.data?.host

	// The API already returns these newest-first, capped.
	const deployments = info.data?.recent_deployments ?? []
	const concerns = useMemo(
		() => concernsOf(projects.data ?? [], certificates.data ?? []),
		[projects.data, certificates.data],
	)

	// The page fits the window and the two lists take what is left, so only they scroll.
	return (
		<Page
			fill
			toolbar={
				<p className='min-w-0 truncate text-sm text-secondary'>
					{host ? `${host.name} · Docker ${host.docker_version} · ` : null}
					Vexdock{' '}
					{version.data?.update_available ? (
						<Link to='/system/settings/about' className='text-warning underline-offset-4 hover:underline'>
							{info.data?.version}, update available
						</Link>
					) : (
						info.data?.version
					)}
				</p>
			}
			filters={<Segmented label='Window' value={window} options={WINDOWS} onChange={setWindow} />}
		>
			<NewProjectDialog open={creating} onOpenChange={setCreating} />

			{concerns.length > 0 ? (
				<Alert
					tone={concerns.some(concern => concern.state === 'failed') ? 'danger' : 'warning'}
					title={`${concerns.length} need${concerns.length === 1 ? 's' : ''} attention`}
					className='mb-6 shrink-0'
				>
					<ul className='grid gap-1'>
						{concerns.map(concern => (
							<li key={concern.id}>
								<Link to={concern.to} className='group/concern inline-flex min-w-0 items-center gap-2'>
									<Status dot value={concern.state} />
									<span className='font-medium text-foreground group-hover/concern:underline'>
										{concern.subject}
									</span>
									<span className='truncate'>{concern.detail}</span>
								</Link>
							</li>
						))}
					</ul>
				</Alert>
			) : null}

			<HostMetrics history={history} window={window} load={stats?.load_average} cpus={host?.cpus} />

			<div className='grid flex-1 gap-6 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[minmax(0,1fr)]'>
				<Section
					title='Projects'
					total={projects.data?.length}
					fill
					actions={
						<Button variant='primary' onClick={() => setCreating(true)}>
							<IconPlus size={16} stroke={1.75} />
							New project
						</Button>
					}
				>
					<DataTable
						data={projects.data ?? []}
						columns={projectColumns}
						loading={projects.isLoading}
						error={projects.error}
						getRowId={project => project.id}
						onRowClick={project =>
							navigate({ to: '/projects/$projectId', params: { projectId: project.id } })
						}
						empty='No projects yet. Create one, then add services to it.'
					/>
				</Section>

				<Section
					title='Deployments'
					fill
					actions={<Refresh onClick={() => info.refetch()} busy={info.isFetching} />}
				>
					<DataTable
						data={deployments}
						columns={recentDeploymentColumns}
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
			</div>
		</Page>
	)
}
