import { createFileRoute } from '@tanstack/react-router'
import { LogViewer } from '../components/log-viewer'
import { NotRunning, useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/logs')({
	component: ServiceLogs,
})

function ServiceLogs() {
	const { serviceId } = Route.useParams()
	const service = useService(serviceId)

	// The layout above shows a failed or pending read of the service.
	if (!service.data) return null
	// No container means no log stream: the manager answers 400 and the viewer would retry forever.
	if (service.data.state === '') {
		return (
			<NotRunning
				service={service.data}
				title='No logs yet'
				description='Logs come from the container, and this service has none yet.'
			/>
		)
	}
	return <LogViewer url={`/api/services/${serviceId}/logs`} />
}
