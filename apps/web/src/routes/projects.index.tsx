import { useState } from 'react'
import { IconFolder, IconPlus } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { NewProjectDialog } from '../components/new-project'
import { Button, Meter, Page, Refresh, RelativeTime, Section, StatStrip, Status } from '../components/primitives'
import { api, type Project } from '../lib/api'

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
			cell: ({ row: { original } }) => (
				<Meter
					label={`${original.running_count}/${original.service_count}`}
					value={original.running_count}
					max={original.service_count}
				/>
			),
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
						<RelativeTime at={original.latest_deployment.created_at} />
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
	const services = data.reduce((total, project) => total + project.service_count, 0)
	const latest = data
		.map(project => project.latest_deployment?.created_at)
		.filter(at => at !== undefined)
		.toSorted()
		.at(-1)

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

			{data.length > 0 ? (
				<StatStrip
					className='mb-4'
					items={[
						{ label: 'Projects', value: data.length },
						{ label: 'Services', value: services },
						{
							label: 'Running',
							value: data.reduce((total, project) => total + project.running_count, 0),
						},
						{ label: 'Domains', value: data.reduce((total, project) => total + project.domains.length, 0) },
						{ label: 'Last deploy', value: latest ? <RelativeTime at={latest} /> : 'never' },
					]}
				/>
			) : null}

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
