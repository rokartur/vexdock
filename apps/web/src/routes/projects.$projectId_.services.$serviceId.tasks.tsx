import { createFileRoute } from '@tanstack/react-router'
import { ScheduledTasks } from '../components/scheduled-tasks'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/tasks')({
	component: ServiceTasks,
})

function ServiceTasks() {
	const { serviceId } = Route.useParams()
	return <ScheduledTasks serviceId={serviceId} />
}
