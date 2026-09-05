import { IconDots, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EnvironmentCrumb, ProjectCrumb } from '../components/crumb-picker'
import { Confirm, ErrorText, IconButton, Page, Tabs } from '../components/primitives'
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
	// The query the crumb picker already runs, so this reads the cache.
	const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.project(projectId) })

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
			name={project.data?.name}
			labels={{
				[projectId]: (
					<>
						<ProjectCrumb projectId={projectId} />
						<span className='text-muted-foreground/60'>/</span>
						<EnvironmentCrumb projectId={projectId} />
					</>
				),
			}}
			actions={
				// Deleting a project is rare and unrecoverable, so it sits behind the
				// overflow instead of one stray click away on every page below here.
				<DropdownMenu>
					<DropdownMenuTrigger
						render={<IconButton icon={IconDots} label='Project actions' size='default' />}
					/>
					<DropdownMenuContent align='end'>
						<Confirm
							title='Delete this project?'
							description='Every service, deployment and domain in it goes with it. Volumes are kept.'
							onConfirm={() => remove.mutate()}
						>
							<DropdownMenuItem variant='destructive' closeOnClick={false}>
								<IconTrash />
								Delete project
							</DropdownMenuItem>
						</Confirm>
					</DropdownMenuContent>
				</DropdownMenu>
			}
			toolbar={<Tabs base={base} tabs={tabs} />}
		>
			<ErrorText error={remove.error} />
			<Outlet />
		</Page>
	)
}
