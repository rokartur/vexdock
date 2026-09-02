import { createFileRoute } from '@tanstack/react-router'
import { DomainsPanel } from '../components/domains-panel'
import { useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/domains')({
	component: ServiceDomains,
})

function ServiceDomains() {
	const { projectId, serviceId } = Route.useParams()
	const service = useService(serviceId)
	if (!service.data) return null
	// Remounts on switch, so the add form's service follows the URL.
	return <DomainsPanel key={service.data.id} projectId={projectId} scope={service.data} />
}
