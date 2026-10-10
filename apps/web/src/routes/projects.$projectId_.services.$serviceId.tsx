import { type QueryClient, useQuery } from '@tanstack/react-query'
import { createFileRoute, Outlet, useMatch } from '@tanstack/react-router'
import { AnimatedNumber } from '../components/animated-number'
import { EnvironmentCrumb, ProjectCrumb, ServiceCrumb } from '../components/crumb-picker'
import { ErrorText, Page, RelativeTime, StatStrip, Status, Tabs } from '../components/primitives'
import { environmentSearch } from '../lib/environment'
import { bytes, percent } from '../lib/format'
import { environmentsQuery, preload, projectQuery, serviceQuery, tasksQuery } from '../lib/queries'

// A service is not one of the project's tabs, so it hangs off `$projectId_`:
// same URL, own header, own toolbar. The environment still travels with it, so
// the crumb above names the environment the service was reached through.
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
	// Same key the tasks tab uses, so the count comes from the cache once that tab has been open.
	const isDatabase = service.data?.type === 'database'
	const tasks = useQuery({
		...tasksQuery(serviceId),
		enabled: service.data !== undefined && !isDatabase,
	})
	const running = service.data?.state === 'running'
	// Studio's grid takes the rest of the window and scrolls inside itself.
	const studio = useMatch({ from: '/projects/$projectId_/services/$serviceId/studio', shouldThrow: false })

	return (
		<Page
			fill={studio !== undefined}
			name={service.data?.compose_service_name}
			// The name and its state live in the trail's service picker.
			labels={{
				[projectId]: (
					<>
						<ProjectCrumb projectId={projectId} />
						<span className='text-muted-foreground/30'>/</span>
						<EnvironmentCrumb projectId={projectId} />
					</>
				),
				services: null,
				[serviceId]: <ServiceCrumb projectId={projectId} serviceId={serviceId} />,
			}}
			toolbar={
				<Tabs
					base={`/projects/${projectId}/services/${serviceId}`}
					tabs={serviceTabs(isDatabase, service.data?.engine, tasks.data?.length)}
				/>
			}
		>
			{/* The same line under every tab, so what the service is doing never depends on which one is open. */}
			{service.error ? <ErrorText error={service.error} /> : null}
			{service.data ? (
				<StatStrip
					className='mb-4'
					items={[
						{ label: 'State', value: <Status value={service.data.state} /> },
						{ label: 'Health', value: service.data.health || '-' },
						{ label: 'Image', value: service.data.running_image || service.data.image || '-' },
						{ label: 'Started', value: <RelativeTime at={service.data.created_unix} /> },
						{
							label: 'CPU',
							value: running ? (
								<AnimatedNumber key={serviceId} value={service.data.cpu_percent} format={percent} />
							) : (
								'-'
							),
						},
						{
							label: 'Memory',
							value: running ? (
								<AnimatedNumber key={serviceId} value={service.data.memory_usage} format={bytes} />
							) : (
								'-'
							),
						},
					]}
				/>
			) : null}
			<Outlet />
		</Page>
	)
}
