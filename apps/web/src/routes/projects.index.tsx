import { useState } from 'react'
import { IconFolder, IconPlus } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { NewProjectDialog } from '../components/new-project'
import { Button, Page, Refresh, Section, Status } from '../components/primitives'
import { api, type Project } from '../lib/api'
import { since } from '../lib/format'

const projectTableColumns: Columns<Project> = (() => {
	const cell = columnsFor<Project>()
	return [
		cell.accessor(project => project.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2 font-medium'>
					<IconFolder className='size-4 text-muted-foreground' />
					{row.original.name}
				</span>
			),
		}),
		cell.accessor(project => tagsOf(project).join(' '), {
			id: 'tags',
			header: 'Tags',
			cell: ({ row }) => {
				const tags = tagsOf(row.original)
				if (tags.length === 0) return <span className='text-muted-foreground'>-</span>
				return (
					<span className='flex flex-wrap gap-1'>
						{tags.map(tag => (
							<Badge key={tag} variant='outline'>
								{tag}
							</Badge>
						))}
					</span>
				)
			},
		}),
		cell.accessor(project => project.running_count, {
			id: 'services',
			header: 'Services',
			meta: { mono: true },
			cell: ({ row: { original } }) => `${original.running_count}/${original.service_count}`,
		}),
		cell.accessor(project => project.domains.length, {
			id: 'domains',
			header: 'Domains',
			meta: { mono: true },
			cell: ({ row }) => row.original.domains.length || '-',
		}),
		cell.accessor(project => project.latest_deployment?.created_at ?? '', {
			id: 'last-deploy',
			header: 'Last deploy',
			cell: ({ row: { original } }) =>
				original.latest_deployment ? (
					<span className='flex items-center gap-2'>
						<Status value={original.latest_deployment.status} />
						<span className='text-muted-foreground'>{since(original.latest_deployment.created_at)}</span>
					</span>
				) : (
					<span className='text-muted-foreground'>never</span>
				),
		}),
	]
})()

export const Route = createFileRoute('/projects/')({ component: ProjectsPage })

function ProjectsPage() {
	const navigate = useNavigate()
	const [creating, setCreating] = useState(false)
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })

	const data = projects.data ?? []

	return (
		<Page
			actions={
				<Button variant='primary' onClick={() => setCreating(true)}>
					<IconPlus />
					New project
				</Button>
			}
		>
			<NewProjectDialog open={creating} onOpenChange={setCreating} />

			<Section
				title='All projects'
				description={`${data.length} total`}
				actions={<Refresh onClick={() => projects.refetch()} busy={projects.isFetching} />}
			>
				<DataTable
					data={data}
					columns={projectTableColumns}
					loading={projects.isLoading}
					getRowId={project => project.id}
					onRowClick={project => navigate({ to: '/projects/$projectId', params: { projectId: project.id } })}
					filter='Filter projects'
					empty='No projects yet. Create one, then add services to it.'
				/>
			</Section>
		</Page>
	)
}

/** Managers older than the tags column answer without the field. */
function tagsOf(project: Project): string[] {
	return project.tags ?? []
}
