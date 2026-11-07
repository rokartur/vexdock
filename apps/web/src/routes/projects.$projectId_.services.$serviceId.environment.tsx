import { IconVariable } from '@tabler/icons-react'
import { queryOptions } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { VariablesCard } from '../components/env-editor'
import { api } from '../lib/api'
import { preload } from '../lib/queries'

const serviceVariablesQuery = (serviceId: string) =>
	queryOptions({ queryKey: ['service', serviceId, 'environment'], queryFn: () => api.serviceVariables(serviceId) })

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/environment')({
	loader: ({ context: { queryClient }, params: { serviceId } }) =>
		preload(queryClient, serviceVariablesQuery(serviceId)),
	component: ServiceEnvironment,
})

/**
 * Managed services get their own .env file, so their credentials never collide
 * with a sibling running the same engine.
 */
function ServiceEnvironment() {
	const { serviceId } = Route.useParams()
	return (
		<div className='max-w-3xl'>
			<VariablesCard
				title='Environment variables'
				icon={IconVariable}
				rows={18}
				query={serviceVariablesQuery(serviceId)}
				save={variables => api.saveServiceVariables(serviceId, variables)}
			/>
		</div>
	)
}
