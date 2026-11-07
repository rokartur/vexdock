import { createFileRoute } from '@tanstack/react-router'
import { DeploymentsPanel, deploymentSearch } from '../components/deployments-panel'
import { preloadServiceDeployments } from '../lib/queries'
import { useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/deployments')({
	loader: ({ context: { queryClient }, params: { projectId, serviceId } }) =>
		preloadServiceDeployments(queryClient, projectId, serviceId),
	component: ServiceDeployments,
	...deploymentSearch,
})

function ServiceDeployments() {
	const { projectId, serviceId } = Route.useParams()
	const service = useService(serviceId)
	if (!service.data) return null
	return <DeploymentsPanel projectId={projectId} service={service.data} />
}
