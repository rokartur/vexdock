import { createFileRoute } from '@tanstack/react-router'
import { Page } from '../components/primitives'
import { ScheduledTasks } from '../components/scheduled-tasks'

export const Route = createFileRoute('/tasks')({ component: Tasks })

/** Every task on the server, managed the same way the service tab manages its own. */
function Tasks() {
	return (
		<Page>
			<ScheduledTasks />
		</Page>
	)
}
