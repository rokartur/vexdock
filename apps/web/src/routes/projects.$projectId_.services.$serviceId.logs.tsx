import { createFileRoute } from '@tanstack/react-router'
import { LogViewer } from '../components/log-viewer'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/logs')({
	component: ServiceLogs,
})

function ServiceLogs() {
	const { serviceId } = Route.useParams()
	return <LogViewer url={`/api/services/${serviceId}/logs`} />
}
