import { createFileRoute } from '@tanstack/react-router'
import { Terminal } from '../components/terminal'
import { useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/terminal')({
	component: ServiceTerminal,
})

function ServiceTerminal() {
	const { serviceId } = Route.useParams()
	const service = useService(serviceId)

	if (service.data?.state !== 'running') {
		return <p className='text-body text-muted-foreground'>Start the service to open a terminal.</p>
	}
	return <Terminal url={terminalUrl(serviceId)} />
}

function terminalUrl(serviceId: string): string {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	return `${protocol}//${window.location.host}/api/services/${serviceId}/terminal`
}
