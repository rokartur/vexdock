import { IconPlayerPlay, IconRocket } from '@tabler/icons-react'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Navigate, Outlet, useLocation, useMatch, useNavigate } from '@tanstack/react-router'
import { AnimatedNumber } from '../components/animated-number'
import { CrumbSeparator, EnvironmentCrumb, ProjectCrumb, ServiceCrumb } from '../components/crumb-picker'
import { Button, EmptyState, ErrorText, FactBar, Page, RelativeTime, Status, Tabs } from '../components/primitives'
import { api, type Service } from '../lib/api'
import { environmentSearch } from '../lib/environment'
import { bytes, percent } from '../lib/format'
import { environmentsQuery, preload, projectQuery, serviceQuery, tasksQuery } from '../lib/queries'

// A service is not one of the project's tabs, so it hangs off `$projectId_`:
// same URL, own header, own toolbar. `?env=` still travels for the links back up;
// the crumbs read the environment from the service itself.
export const Route = createFileRoute('/projects/$projectId_/services/$serviceId')({
	loader: ({ context: { queryClient }, params: { projectId, serviceId } }) =>
		Promise.all([
			preload(queryClient, projectQuery(projectId)),
			preload(queryClient, environmentsQuery(projectId)),
			preloadServiceAndTasks(queryClient, serviceId),
		]),
	component: ServiceLayout,
	...environmentSearch,
})

async function preloadServiceAndTasks(queryClient: QueryClient, serviceId: string) {
	await preload(queryClient, serviceQuery(serviceId))
	// A database has no Tasks tab, so the layout never asks for its tasks.
	if (queryClient.getQueryData(serviceQuery(serviceId).queryKey)?.type === 'database') return
	await preload(queryClient, tasksQuery(serviceId))
}

/** The service a section is about: one cache entry, refreshed on container events. */
export function useService(serviceId: string) {
	return useQuery(serviceQuery(serviceId))
}

/** A tab that needs the container (Studio, Terminal, Logs) offers to start it, or to deploy it if it never ran. */
export function NotRunning({
	service,
	title,
	description,
	heading = 'h2',
}: {
	service: Service
	title: string
	description: string
	/** `h3` inside a Section, whose title is the h2. */
	heading?: 'h2' | 'h3'
}) {
	const queryClient = useQueryClient()
	const navigate = useNavigate()
	const { projectId } = Route.useParams()
	const serviceId = service.id
	// An empty state means no container yet, which only a deploy creates; the manager refuses Start for it.
	// A restarting container comes back on its own, as on the General tab; Docker refuses Start for a paused one.
	const startable = !['', 'restarting', 'paused'].includes(service.state)
	const unconfigured = service.provider === 'unconfigured'
	let next = 'Deploy it to create the container.'
	if (service.state === 'paused') next = 'It was paused outside Vexdock; stop it on the General tab, then start it.'
	else if (service.state === 'restarting' && unconfigured)
		next = 'It is restarting and comes back on its own; deploying needs a source from the General tab first.'
	else if (service.state === 'restarting') next = 'It is restarting and comes back on its own.'
	else if (startable && unconfigured) next = 'Start it; deploying needs a source from the General tab first.'
	else if (startable) next = 'Start it, or deploy it again.'
	else if (unconfigured) next = 'Pick a source on the General tab, then deploy it.'
	const onSuccess = () => queryClient.invalidateQueries({ queryKey: ['service', serviceId] })
	const start = useMutation({ mutationFn: () => api.serviceAction(serviceId, 'start'), onSuccess })
	// Same landing as the General tab's Deploy: the new deployment's log.
	const deploy = useMutation({
		mutationFn: () => api.deployService(serviceId),
		onSuccess: async deployment => {
			await onSuccess()
			await queryClient.invalidateQueries({ queryKey: ['deployments', projectId] })
			await navigate({
				to: '/projects/$projectId/services/$serviceId/deployments',
				params: { projectId, serviceId },
				search: { deployment: deployment.id },
			})
		},
	})
	return (
		<div className='rounded-surface border bg-surface'>
			<EmptyState scene='offline' heading={heading} title={title} description={`${description} ${next}`}>
				<ErrorText error={start.error ?? deploy.error} />
				<div className='flex gap-2'>
					{startable ? (
						<Button onClick={() => start.mutate()} loading={start.isPending} disabled={deploy.isPending}>
							<IconPlayerPlay size={16} stroke={1.75} />
							Start
						</Button>
					) : null}
					<Button
						variant='primary'
						onClick={() => deploy.mutate()}
						loading={deploy.isPending}
						disabled={start.isPending || unconfigured}
					>
						<IconRocket size={16} stroke={1.75} />
						Deploy
					</Button>
				</div>
			</EmptyState>
		</div>
	)
}

// Dokploy's order: what you configure first, what you watch after.
// A database is only reached on the internal network, so the dashboard offers it no domains and no tasks.
// Studio speaks the catalog engines' protocols; a custom image's is unknown.
const serviceTabs = (isDatabase: boolean, engine: string | undefined, taskCount: number | undefined) => [
	{ suffix: '', label: 'General' },
	...(isDatabase && engine !== 'custom' ? [{ suffix: '/studio', label: 'Studio' }] : []),
	{ suffix: '/environment', label: 'Environment' },
	...(isDatabase ? [] : [{ suffix: '/domains', label: 'Domains' }]),
	{ suffix: '/deployments', label: 'Deployments' },
	{ suffix: '/logs', label: 'Logs' },
	{ suffix: '/terminal', label: 'Terminal' },
	...(isDatabase ? [] : [{ suffix: '/tasks', label: 'Tasks', count: taskCount }]),
	{ suffix: '/monitoring', label: 'Monitoring' },
	{ suffix: '/advanced', label: 'Advanced' },
]

function ServiceLayout() {
	const { projectId, serviceId } = Route.useParams()
	const service = useService(serviceId)
	const isDatabase = service.data?.type === 'database'
	// The loader preloads this; the Tasks tab reads the same key.
	const tasks = useQuery({
		...tasksQuery(serviceId),
		enabled: service.data !== undefined && !isDatabase,
	})
	const running = service.data?.state === 'running'
	const image = service.data?.running_image || service.data?.image || '-'
	// Studio's grid takes the rest of the window and scrolls inside itself.
	const studio = useMatch({ from: '/projects/$projectId_/services/$serviceId/studio', shouldThrow: false })
	const base = `/projects/${projectId}/services/${serviceId}`
	const tabs = serviceTabs(isDatabase, service.data?.engine, tasks.data?.length)
	// A typed or bookmarked URL can name a tab this service does not offer, such as a database's Domains.
	const tab = useLocation({ select: location => location.pathname.slice(base.length).split('/')[1] ?? '' })
	// Only the tabs `serviceTabs` can hide; a mistyped one falls through to the not-found page.
	const offered =
		!service.data ||
		!['studio', 'domains', 'tasks'].includes(tab) ||
		tabs.some(({ suffix }) => suffix === `/${tab}`)

	return (
		<Page
			fill={studio !== undefined}
			name={service.data?.compose_service_name}
			index='General'
			// The name and its state live in the trail's service picker.
			labels={{
				[projectId]: (
					<>
						<ProjectCrumb projectId={projectId} />
						<CrumbSeparator />
						<EnvironmentCrumb projectId={projectId} serviceId={serviceId} />
					</>
				),
				services: null,
				[serviceId]: <ServiceCrumb projectId={projectId} serviceId={serviceId} />,
			}}
			toolbar={<Tabs base={base} tabs={tabs} />}
		>
			{/* The same line under every tab, so what the service is doing never depends on which one is open. */}
			{service.error ? <ErrorText error={service.error} /> : null}
			{service.data ? (
				<FactBar
					className='mb-4'
					state={
						service.data.provider === 'unconfigured' && service.data.state === '' ? (
							<span className='text-muted'>needs a source</span>
						) : (
							<Status value={service.data.state || 'stopped'} />
						)
					}
					items={[
						{
							label: 'Health',
							// Docker reports no health for a container without a healthcheck; no state means no container.
							value: service.data.health || (
								<span className='text-muted'>{service.data.state ? 'no check' : '-'}</span>
							),
						},
						{
							label: 'Image',
							grow: true,
							value: <span className='font-mono text-xs'>{image}</span>,
						},
						// The container is recreated on every deploy, so its creation is the last ship.
						{
							label: 'Deployed',
							value: service.data.created_unix ? (
								<RelativeTime at={service.data.created_unix} />
							) : (
								<span className='text-muted'>Never</span>
							),
						},
						{
							label: 'CPU',
							value: running ? (
								<AnimatedNumber key={serviceId} value={service.data.cpu_percent} format={percent} />
							) : (
								<span className='text-muted'>-</span>
							),
						},
						{
							label: 'Memory',
							value: running ? (
								<AnimatedNumber key={serviceId} value={service.data.memory_usage} format={bytes} />
							) : (
								<span className='text-muted'>-</span>
							),
						},
					]}
				/>
			) : null}
			{offered ? (
				// The crumb's switch keeps the tab and swaps the service, so every tab starts over with no state from the last one.
				<Outlet key={serviceId} />
			) : (
				<Navigate to='/projects/$projectId/services/$serviceId' params={{ projectId, serviceId }} replace />
			)}
		</Page>
	)
}
