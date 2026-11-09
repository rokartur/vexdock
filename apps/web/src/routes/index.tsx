import { useMemo, useState } from 'react'
import { IconPlayerPause, IconPlayerPlay, IconPlus } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, type LinkOptions, linkOptions, useNavigate } from '@tanstack/react-router'
import { cn } from 'cn'
import { Alert } from '@/components/ui/alert'
import { type Columns, DataTable, RowTitle, columnsFor } from '../components/data-table'
import { DeploymentDetail } from '../components/deployment-detail'
import { HostMetrics } from '../components/host-metrics'
import { NewProjectDialog } from '../components/new-project'
import {
	Button,
	EmptyState,
	ErrorText,
	IconButton,
	Page,
	PendingReading,
	Refresh,
	RelativeTime,
	Section,
	Status,
	textLink,
} from '../components/primitives'
import { type Certificate, certificateStatus, type HostStats, type Project, type SystemInfo } from '../lib/api'
import { since, until } from '../lib/format'
import { certificatesQuery, preload, projectsQuery, systemInfoQuery, versionQuery } from '../lib/queries'
import { useEventSource } from '../lib/sse'

/** Close enough to expiry that a renewal which has not happened yet is worth reading as a problem. */
const EXPIRY_WARNING_DAYS = 21

/** Where a concern is fixed: a project's services, an uploaded certificate's list, or the Domains tab that renews one. */
type Concern = { id: string; state: string; subject: string; detail: string; link: LinkOptions }

/** The two things on this page that are wrong rather than merely notable: services Docker gave up on, and certificates running out. */
function concernsOf(projects: Project[], certificates: Certificate[]): Concern[] {
	const deadline = Date.now() + EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000
	const certificateOf = new Map(certificates.map(certificate => [certificate.domain_id, certificate]))
	const concerns: Concern[] = []
	for (const project of projects) {
		if (project.errored_count > 0) {
			concerns.push({
				id: project.id,
				state: 'failed',
				subject: project.name,
				detail: `${project.errored_count} of ${project.service_count} service${project.service_count === 1 ? '' : 's'} errored`,
				link: linkOptions({
					to: '/projects/$projectId',
					params: { projectId: project.id },
					search: project.errored_environment ? { env: project.errored_environment } : {},
				}),
			})
		}
		for (const domain of project.domains) {
			const certificate = certificateOf.get(domain.id)
			if (!certificate) continue
			const expiry = Date.parse(certificate.expires_at)
			const expiring = !Number.isNaN(expiry) && expiry < deadline
			if (certificate.status !== 'failed' && !expiring) continue
			const uploaded = certificate.source === 'custom'
			const expired = certificateStatus(certificate) === 'expired'
			let detail = `certificate expires ${until(certificate.expires_at)}`
			if (certificate.status === 'failed') detail = certificate.last_error || 'certificate could not be issued'
			else if (expired) detail = `certificate expired ${since(certificate.expires_at)}`
			concerns.push({
				id: certificate.id,
				state: certificate.status === 'failed' || expired ? 'failed' : 'pending',
				subject: certificate.hostname,
				detail,
				link: uploaded
					? linkOptions({ to: '/system/certificates' })
					: linkOptions({
							to: '/projects/$projectId/services/$serviceId/domains',
							params: { projectId: domain.project_id, serviceId: domain.service_id },
							search: { env: domain.environment_id },
						}),
			})
		}
	}
	return concerns
}

type RecentDeployment = SystemInfo['recent_deployments'][number]

const renderDeploymentDetail = ({ deployment }: RecentDeployment) => <DeploymentDetail deploymentId={deployment.id} />
const deploymentName = ({ deployment }: RecentDeployment) => `${deployment.service_name} #${deployment.number}`
const deploymentPlace = ({ project_name, environment_name }: RecentDeployment) =>
	[project_name || '-', environment_name].filter(Boolean).join(' · ')

const recentDeploymentColumns: Columns<RecentDeployment> = (() => {
	const cell = columnsFor<RecentDeployment>()
	return [
		cell.accessor(deploymentName, {
			id: 'deployment',
			header: 'Deployment',
			cell: ({ row: { original } }) => (
				<span className='flex items-center gap-2.5'>
					<Status dot run value={original.deployment.status} />
					<span className='grid max-w-60 min-w-0'>
						<RowTitle className='max-w-full justify-self-start truncate font-mono'>
							{deploymentName(original)}
						</RowTitle>
						<span className='truncate text-xs text-muted'>{deploymentPlace(original)}</span>
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
			cell: ({ row }) => (
				<Link
					to='/projects/$projectId'
					params={{ projectId: row.original.id }}
					tabIndex={-1}
					title={row.original.name}
					className={cn(textLink, 'block max-w-56 truncate font-medium')}
				>
					{row.original.name}
				</Link>
			),
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
					<span className='whitespace-nowrap text-secondary'>
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
				if (!latest) return <span className='text-muted'>Never</span>
				return (
					<span className='flex items-center gap-2 whitespace-nowrap'>
						<Status run value={latest.status} />
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
			className='flex flex-wrap gap-1'
		>
			{squares.map((tone, index) => (
				// oxlint-disable-next-line react/no-array-index-key -- squares carry no identity, only a count
				<span key={index} className={cn('size-2.5 rounded-[3px]', tone)} />
			))}
		</span>
	)
}

export const Route = createFileRoute('/')({
	loader: ({ context: { queryClient } }) =>
		Promise.all([
			preload(queryClient, systemInfoQuery),
			preload(queryClient, versionQuery),
			preload(queryClient, certificatesQuery),
			preload(queryClient, projectsQuery),
		]),
	component: DashboardPage,
})

function DashboardPage() {
	const navigate = useNavigate()
	const info = useQuery(systemInfoQuery)
	const version = useQuery(versionQuery)
	const projects = useQuery(projectsQuery)
	const certificates = useQuery(certificatesQuery)
	const [stats, setStats] = useState<HostStats | null>(null)
	const [paused, setPaused] = useState(false)
	const [openDeployment, setOpenDeployment] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)

	const stream = useEventSource('/api/system/stats', { stats: data => setStats(data as HostStats) }, !paused)

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
			// A caption, not a FactBar: the page's one strip is HostMetrics, and these words fit beside the pause button.
			toolbar={
				info.data ? (
					<p className='min-w-0 truncate text-sm text-secondary max-sm:whitespace-normal'>
						{`${info.data.host.name} · Docker ${info.data.host.docker_version} · `}
						Vexdock{' '}
						{version.data?.update_available ? (
							<Link to='/system/settings/about' className={cn(textLink, 'text-warning')}>
								{info.data.version}, update available
							</Link>
						) : (
							info.data.version
						)}
					</p>
				) : (
					<PendingReading label='host' failed={info.isError} />
				)
			}
			// WCAG 2.2.2: readings that keep moving beside other content can be held still.
			filters={
				<IconButton
					icon={paused ? IconPlayerPlay : IconPlayerPause}
					label={paused ? 'Resume live readings' : 'Pause live readings'}
					onClick={() => setPaused(!paused)}
				/>
			}
		>
			<NewProjectDialog open={creating} onOpenChange={setCreating} />
			{/* Without it, a failed read drops every certificate concern and the page reads as all clear. */}
			<ErrorText error={certificates.error} className='mb-6' />

			{concerns.length > 0 ? (
				<Alert
					tone={concerns.some(concern => concern.state === 'failed') ? 'danger' : 'warning'}
					title={`${concerns.length} need${concerns.length === 1 ? 's' : ''} attention`}
					className='mb-6 shrink-0'
				>
					<ul className='grid gap-1'>
						{concerns.map(concern => (
							<li key={concern.id}>
								<Link
									{...concern.link}
									className='group/concern inline-flex min-w-0 press items-center gap-2'
								>
									<Status dot value={concern.state} />
									<span className='font-medium text-foreground underline decoration-transparent underline-offset-4 transition-[text-decoration-color] duration-110 ease-standard group-hover/concern:decoration-current group-active/concern:decoration-current'>
										{concern.subject}
									</span>
									<span className='truncate'>{concern.detail}</span>
								</Link>
							</li>
						))}
					</ul>
				</Alert>
			) : null}

			<HostMetrics stats={stats} cpus={host?.cpus} failed={stream === 'lost'} />

			<div className='grid flex-1 grid-cols-[minmax(0,1fr)] gap-6 xl:min-h-0 xl:grid-cols-[minmax(0,1fr)_24rem] xl:grid-rows-[minmax(0,1fr)]'>
				<Section
					title='Projects'
					total={projects.data?.length}
					fill
					actions={
						<>
							<Refresh label='Refresh projects' onClick={() => projects.refetch()} />
							<Button variant='primary' size='sm' onClick={() => setCreating(true)}>
								<IconPlus size={16} stroke={1.75} />
								New project
							</Button>
						</>
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
						empty={
							<EmptyState
								title='No projects yet'
								description='New project creates one, then add services to it.'
							/>
						}
					/>
				</Section>

				<Section
					title='Deployments'
					fill
					actions={<Refresh label='Refresh deployments' onClick={() => info.refetch()} />}
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
							title: deploymentName,
							description: deploymentPlace,
							render: renderDeploymentDetail,
						}}
						empty={
							<EmptyState
								title='No deployments yet'
								description='Open a project in the list and deploy one of its services; the run lists here.'
							/>
						}
					/>
				</Section>
			</div>
		</Page>
	)
}
