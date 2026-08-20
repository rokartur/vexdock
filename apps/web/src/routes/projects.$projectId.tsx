import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, retainSearchParams, useNavigate, useParams } from '@tanstack/react-router'
import { EnvironmentCrumb, ProjectCrumb, ServiceCrumb } from '../components/crumb-picker'
import { Button, ErrorText, Page, Tabs } from '../components/primitives'
import { api } from '../lib/api'

export const Route = createFileRoute('/projects/$projectId')({
	component: ProjectLayout,
	// Every page below this one acts on one environment, so it belongs in the
	// URL rather than in a store: a pasted link lands on the same environment it
	// was copied from. Retaining it keeps the tabs from silently falling back to
	// the default one on every click.
	validateSearch: (search: Record<string, unknown>): { env?: string } =>
		typeof search.env === 'string' ? { env: search.env } : {},
	search: { middlewares: [retainSearchParams(['env'])] },
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
	// Only the service route has one, and it owns the deepest crumb, which this
	// layout's Page is the one that renders.
	const { serviceId } = useParams({ strict: false })
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
				services: null,
				...(serviceId ? { [serviceId]: <ServiceCrumb projectId={projectId} serviceId={serviceId} /> } : {}),
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
