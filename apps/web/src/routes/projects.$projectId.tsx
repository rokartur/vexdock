import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EnvironmentCrumb, ProjectCrumb } from '../components/crumb-picker'
import { Button, ErrorText, Page, Tabs } from '../components/primitives'
import { api } from '../lib/api'
import { environmentSearch } from '../lib/environment'

export const Route = createFileRoute('/projects/$projectId')({
	component: ProjectLayout,
	...environmentSearch,
})

const tabs = [
	{ suffix: '', label: 'Services' },
	{ suffix: '/deployments', label: 'Deployments' },
	{ suffix: '/domains', label: 'Domains' },
	{ suffix: '/environment', label: 'Variables' },
	{ suffix: '/settings', label: 'Settings' },
]

function ProjectLayout() {
	const { projectId } = Route.useParams()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [confirmDelete, setConfirmDelete] = useState(false)

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
						<ProjectCrumb projectId={projectId} />
						<span className='text-muted-foreground'>/</span>
						<EnvironmentCrumb projectId={projectId} />
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
					// Deleting a project is rare and unrecoverable, so it sits behind the
					// overflow instead of one stray click away on every page below here.
					<DropdownMenu>
						<DropdownMenuTrigger render={<Button variant='ghost' aria-label='Project actions' />}>
							···
						</DropdownMenuTrigger>
						<DropdownMenuContent align='end'>
							<DropdownMenuItem variant='destructive' onClick={() => setConfirmDelete(true)}>
								Delete project
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)
			}
			toolbar={<Tabs base={base} tabs={tabs} />}
		>
			<ErrorText error={remove.error} />
			<Outlet />
		</Page>
	)
}
