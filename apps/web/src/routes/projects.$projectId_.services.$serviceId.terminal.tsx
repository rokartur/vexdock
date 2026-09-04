import { IconTerminal2 } from '@tabler/icons-react'
import { createFileRoute } from '@tanstack/react-router'
import { EmptyState } from '../components/primitives'
import { Terminal } from '../components/terminal'
import { useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/terminal')({
	component: ServiceTerminal,
})

function ServiceTerminal() {
	const { serviceId } = Route.useParams()
	const service = useService(serviceId)

	if (service.data?.state !== 'running') {
		return (
			<div className='rounded-xl border bg-card'>
				<EmptyState icon={IconTerminal2} title='Start the service to open a terminal' />
			</div>
		)
	}
	return <Terminal url={terminalUrl(serviceId)} />
}

function terminalUrl(serviceId: string): string {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	return `${protocol}//${window.location.host}/api/services/${serviceId}/terminal`
}
