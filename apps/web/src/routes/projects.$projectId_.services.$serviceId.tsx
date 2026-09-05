import { IconPlayerStop, IconRefresh, IconRocket } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { EnvironmentCrumb, ProjectCrumb, ServiceCrumb } from '../components/crumb-picker'
import { Button, ErrorText, Page, Tabs } from '../components/primitives'
import { api } from '../lib/api'
import { environmentSearch } from '../lib/environment'

// A service is not one of the project's tabs, so it hangs off `$projectId_`:
// same URL, own header, own toolbar. The environment still travels with it, so
// the crumb above names the environment the service was reached through.
export const Route = createFileRoute('/projects/$projectId_/services/$serviceId')({
	component: ServiceLayout,
	...environmentSearch,
})

/** The service a section is about: one cache entry, refreshed on container events. */
export function useService(serviceId: string) {
	return useQuery({ queryKey: ['service', serviceId], queryFn: () => api.service(serviceId) })
}

// Dokploy's order: what you configure first, what you watch after.
const tabs = [
	{ suffix: '', label: 'General' },
	{ suffix: '/environment', label: 'Environment' },
	{ suffix: '/domains', label: 'Domains' },
	{ suffix: '/deployments', label: 'Deployments' },
	{ suffix: '/logs', label: 'Logs' },
	{ suffix: '/terminal', label: 'Terminal' },
	{ suffix: '/tasks', label: 'Tasks' },
	{ suffix: '/monitoring', label: 'Monitoring' },
	{ suffix: '/advanced', label: 'Advanced' },
]

function ServiceLayout() {
	const { projectId, serviceId } = Route.useParams()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const service = useService(serviceId)

	const running = service.data?.state === 'running'
	const canDeploy = Boolean(service.data && service.data.provider !== 'unconfigured')

	const act = useMutation({
		mutationFn: (action: 'stop' | 'restart') => api.serviceAction(serviceId, action),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', serviceId] }),
	})
	const deploy = useMutation({
		mutationFn: () => api.deployService(serviceId),
		onSuccess: async deployment => {
			await queryClient.invalidateQueries({ queryKey: ['service', serviceId] })
			// The service's own deployments tab, so the log opens without leaving it.
			await navigate({
				to: '/projects/$projectId/services/$serviceId/deployments',
				params: { projectId, serviceId },
				search: previous => ({ ...previous, deployment: deployment.id }),
			})
		},
	})

	return (
		<Page
			name={service.data?.compose_service_name}
			// The name and its state live in the trail's service picker.
			labels={{
				[projectId]: (
					<>
						<ProjectCrumb projectId={projectId} />
						<span className='text-muted-foreground/60'>/</span>
						<EnvironmentCrumb projectId={projectId} />
					</>
				),
				services: null,
				[serviceId]: <ServiceCrumb projectId={projectId} serviceId={serviceId} />,
			}}
			actions={
				<>
					<Button variant='primary' onClick={() => deploy.mutate()} disabled={!canDeploy || deploy.isPending}>
						<IconRocket />
						{deploy.isPending ? 'Starting…' : 'Deploy'}
					</Button>
					<Button onClick={() => act.mutate('restart')} disabled={!running}>
						<IconRefresh />
						Restart
					</Button>
					<Button onClick={() => act.mutate('stop')} disabled={!running || act.isPending}>
						<IconPlayerStop />
						Stop
					</Button>
				</>
			}
			toolbar={<Tabs base={`/projects/${projectId}/services/${serviceId}`} tabs={tabs} />}
		>
			<ErrorText error={deploy.error ?? act.error} />
			<Outlet />
		</Page>
	)
}
