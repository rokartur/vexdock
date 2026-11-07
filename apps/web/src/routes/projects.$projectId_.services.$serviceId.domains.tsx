import { createFileRoute } from '@tanstack/react-router'
import { DomainsPanel } from '../components/domains-panel'
import { certificatesQuery, preload, projectDomainsQuery } from '../lib/queries'
import { useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/domains')({
	loader: ({ context: { queryClient }, params: { projectId } }) =>
		Promise.all([preload(queryClient, projectDomainsQuery(projectId)), preload(queryClient, certificatesQuery)]),
	component: ServiceDomains,
})

function ServiceDomains() {
	const { projectId, serviceId } = Route.useParams()
	const service = useService(serviceId)
	if (!service.data) return null
	return <DomainsPanel projectId={projectId} service={service.data} />
}
