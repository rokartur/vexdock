import { useState } from 'react'
import { IconDots, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from '@/components/ui/dropdown-menu'
import { CrumbSeparator, EnvironmentCrumb, ProjectCrumb } from '../components/crumb-picker'
import { Confirm, ErrorText, IconButton, Page, Tabs } from '../components/primitives'
import { api } from '../lib/api'
import { environmentSearch } from '../lib/environment'
import { environmentsQuery, preload, projectQuery } from '../lib/queries'

export const Route = createFileRoute('/projects/$projectId')({
	loader: ({ context: { queryClient }, params: { projectId } }) =>
		Promise.all([
			preload(queryClient, projectQuery(projectId)),
			preload(queryClient, environmentsQuery(projectId)),
		]),
	component: ProjectLayout,
	...environmentSearch,
})

const tabs = [
	{ suffix: '', label: 'Services' },
	{ suffix: '/environment', label: 'Variables' },
	{ suffix: '/settings', label: 'Settings' },
]

function ProjectLayout() {
	const { projectId } = Route.useParams()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const project = useQuery(projectQuery(projectId))
	const [confirmingDelete, setConfirmingDelete] = useState(false)

	const remove = useMutation({
		mutationFn: () => api.deleteProject(projectId),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['projects'] })
			await navigate({ to: '/projects' })
		},
	})

	const base = `/projects/${projectId}`

	return (
		<Page
			name={project.data?.name}
			index='Services'
			labels={{
				environment: 'Variables',
				[projectId]: (
					<>
						<ProjectCrumb projectId={projectId} />
						<CrumbSeparator />
						<EnvironmentCrumb projectId={projectId} />
					</>
				),
			}}
			actions={
				// Deleting a project is rare and unrecoverable, so it sits behind the
				// overflow instead of one stray click away on every page below here.
				project.data ? (
					<>
						<DropdownMenu
							trigger={
								<IconButton
									icon={IconDots}
									label='Project actions'
									size='default'
									loading={remove.isPending}
								/>
							}
							items={[
								project.data.service_count > 0
									? {
											// The count spans every environment, while the Services tab lists one.
											label: `Delete its services first: ${project.data.service_count} across environments`,
											icon: <IconTrash size={16} stroke={1.75} />,
											disabled: true,
										}
									: {
											label: 'Delete project',
											icon: <IconTrash size={16} stroke={1.75} />,
											destructive: true,
											onSelect: () => setConfirmingDelete(true),
										},
							]}
						/>
						<Confirm
							open={confirmingDelete}
							onOpenChange={setConfirmingDelete}
							title='Delete this project?'
							description='Its environments and variables go with it.'
							action='Delete project'
							type={project.data.name}
							onConfirm={() => remove.mutate()}
						/>
					</>
				) : null
			}
			toolbar={<Tabs base={base} tabs={tabs} />}
		>
			<ErrorText error={project.error} />
			<ErrorText error={remove.error} />
			<Outlet />
		</Page>
	)
}
