import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button, ErrorText, FormSection } from '../components/primitives'
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
	const [confirmDelete, setConfirmDelete] = useState(false)

	const remove = useMutation({
		mutationFn: () => api.deleteService(serviceId),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['services', projectId] })
			await navigate({ to: '/projects/$projectId', params: { projectId } })
		},
	})

	return (
		<FormSection
			title='Delete service'
			description='Removes it from the compose overlay and drops its environment. The data volume stays, so recreating the service under the same name picks it back up.'
		>
			<ErrorText error={remove.error} />
			{confirmDelete ? (
				<div className='flex gap-2'>
					<Button variant='danger' onClick={() => remove.mutate()} disabled={remove.isPending}>
						{remove.isPending ? 'Deleting…' : `Delete ${service.data?.compose_service_name ?? 'service'}`}
					</Button>
					<Button variant='ghost' onClick={() => setConfirmDelete(false)}>
						Cancel
					</Button>
				</div>
			) : (
				<Button variant='danger' onClick={() => setConfirmDelete(true)}>
					Delete service
				</Button>
			)}
		</FormSection>
	)
}
