import { createFileRoute } from '@tanstack/react-router'
import { Terminal } from '../components/terminal'
import { NotRunning, useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/terminal')({
	component: ServiceTerminal,
})

function ServiceTerminal() {
	const { serviceId } = Route.useParams()
	const service = useService(serviceId)

	// The layout above shows a failed or pending read of the service.
	if (!service.data) return null
	if (service.data.state !== 'running') {
		return (
			<NotRunning
				service={service.data}
				title='The service is not running'
				description='A terminal opens a shell inside the running container.'
			/>
		)
	}
	return <Terminal url={terminalUrl(serviceId)} />
}

function terminalUrl(serviceId: string): string {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	return `${protocol}//${window.location.host}/api/services/${serviceId}/terminal`
}
