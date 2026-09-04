import { IconTrash } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button, Confirm, ErrorText, FormSection } from '../components/primitives'
import { api } from '../lib/api'
import { useService } from './projects.$projectId_.services.$serviceId'

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/advanced')({
	component: ServiceAdvanced,
})

/** The rare and the unrecoverable, kept off the tabs a deploy needs. */
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
			await navigate({ to: '/projects/$projectId', params: { projectId } })
		},
	})

	return (
		<div className='max-w-3xl'>
			<FormSection
				title='Delete service'
				description='Removes it from the compose overlay and drops its environment.'
				icon={IconTrash}
				hint='The data volume stays, so recreating the service under the same name picks it back up.'
				actions={
					<Confirm
						title={`Delete ${name}?`}
						description='Its container is removed and its environment dropped. The data volume stays.'
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
				<p className='text-body text-muted-foreground'>Deleting {name} cannot be undone from the panel.</p>
			</FormSection>
		</div>
	)
}
