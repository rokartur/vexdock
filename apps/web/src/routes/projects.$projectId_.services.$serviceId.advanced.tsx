import { IconTrash } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button, Confirm, ErrorText, FormSection } from '../components/primitives'
import { ServiceRouting } from '../components/service-routing'
import { api } from '../lib/api'
import { useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/advanced')({
	component: ServiceAdvanced,
})

/** The rare and the unrecoverable, kept off the tabs a deploy needs: proxy rules, host ports, deletion. */
function ServiceAdvanced() {
	const { projectId, serviceId } = Route.useParams()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const service = useService(serviceId)

	const remove = useMutation({
		mutationFn: () => api.deleteService(serviceId),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['services', projectId] })
			await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
			await queryClient.invalidateQueries({ queryKey: ['projects'] })
			await navigate({ to: '/projects/$projectId', params: { projectId } })
		},
	})

	// The layout above shows a failed or pending read of the service; Delete needs the real name to type.
	if (!service.data) return null
	const name = service.data.compose_service_name
	return (
		<div className='max-w-3xl'>
			<ServiceRouting projectId={projectId} service={service.data} />
			<FormSection
				title='Delete service'
				icon={IconTrash}
				hint='Its named volumes stay, so a service recreated under the same name picks them back up.'
				actions={
					<Confirm
						title={`Delete ${name}?`}
						description='Its container, environment variables, domains, scheduled tasks and routing rules are removed. Its named volumes stay.'
						action='Delete service'
						type={name}
						onConfirm={() => remove.mutate()}
					>
						<Button variant='danger' loading={remove.isPending}>
							<IconTrash size={16} stroke={1.75} />
							Delete service
						</Button>
					</Confirm>
				}
			>
				<ErrorText error={remove.error} />
			</FormSection>
		</div>
	)
}
