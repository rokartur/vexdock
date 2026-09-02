import { createFileRoute } from '@tanstack/react-router'
import { DeploymentsPanel, deploymentSearch } from '../components/deployments-panel'

export const Route = createFileRoute('/projects/$projectId/deployments')({
	component: ProjectDeployments,
	...deploymentSearch,
})

function ProjectDeployments() {
	const { projectId } = Route.useParams()
	return <DeploymentsPanel projectId={projectId} />
}
