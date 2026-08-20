import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { Button, ErrorText, Page, Status, Tabs } from '../components/primitives'
import { api } from '../lib/api'

export const Route = createFileRoute('/projects/$projectId')({ component: ProjectLayout })

const tabs = [
	{ suffix: '', label: 'Services' },
	{ suffix: '/deployments', label: 'Deployments' },
	{ suffix: '/domains', label: 'Domains' },
	{ suffix: '/environment', label: 'Environment' },
	{ suffix: '/settings', label: 'Settings' },
]

function ProjectLayout() {
	const { projectId } = Route.useParams()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [confirmDelete, setConfirmDelete] = useState(false)

	const project = useQuery({
		queryKey: ['project', projectId],
		queryFn: () => api.project(projectId),
		refetchInterval: 10_000,
	})

	const remove = useMutation({
		mutationFn: () => api.deleteProject(projectId, false),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['projects'] })
			await navigate({ to: '/projects' })
		},
	})

	const base = `/projects/${projectId}`

	return (
		<Page
			labels={{
				[projectId]: (
					<>
						{project.data?.name ?? projectId}
						{project.data?.latest_deployment ? (
							<Status value={project.data.latest_deployment.status} />
						) : null}
					</>
				),
			}}
			actions={
				confirmDelete ? (
					<>
						<Button variant='danger' onClick={() => remove.mutate()} disabled={remove.isPending}>
							Confirm delete
						</Button>
						<Button variant='ghost' onClick={() => setConfirmDelete(false)}>
							Cancel
						</Button>
					</>
				) : (
					<Button variant='danger' onClick={() => setConfirmDelete(true)}>
						Delete
					</Button>
				)
			}
			toolbar={<Tabs base={base} tabs={tabs} />}
		>
			<ErrorText error={remove.error} />
			<Outlet />
		</Page>
	)
}
