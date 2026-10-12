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
	const name = service.data?.compose_service_name ?? 'service'

	const remove = useMutation({
		mutationFn: () => api.deleteService(serviceId),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['services', projectId] })
			await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
			await navigate({ to: '/projects/$projectId', params: { projectId } })
		},
	})

	return (
		<div className='max-w-3xl'>
			{service.data ? (
				<ServiceRouting key={service.data.id} projectId={projectId} service={service.data} />
			) : null}
			<FormSection
				title='Delete service'
				icon={IconTrash}
				hint='The data volume stays, so recreating the service under the same name picks it back up.'
				actions={
					<Confirm
						title={`Delete ${name}?`}
						description='Its container is removed and its environment dropped. The data volume stays.'
						type={name}
						onConfirm={() => remove.mutate()}
					>
						<Button variant='danger' disabled={remove.isPending}>
							<IconTrash />
							{remove.isPending ? 'Deleting…' : 'Delete service'}
						</Button>
					</Confirm>
				}
			>
				<ErrorText error={remove.error} />
				<p className='text-sm text-muted'>Deleting {name} cannot be undone from the panel.</p>
			</FormSection>
		</div>
	)
}
