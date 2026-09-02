import { createFileRoute } from '@tanstack/react-router'
import { DomainsPanel } from '../components/domains-panel'

export const Route = createFileRoute('/projects/$projectId/domains')({ component: ProjectDomains })

function ProjectDomains() {
	const { projectId } = Route.useParams()
	return <DomainsPanel projectId={projectId} />
}
