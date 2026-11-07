import { type ReactNode, useState } from 'react'
import { IconFolder, IconPlus } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { NewProjectDialog } from '../components/new-project'
import {
	Button,
	EmptyState,
	Meter,
	Page,
	PendingReading,
	Refresh,
	RelativeTime,
	Section,
	StatStrip,
	Status,
	textLink,
} from '../components/primitives'
import type { Project } from '../lib/api'
import { preload, projectsQuery } from '../lib/queries'

const projectTableColumns: Columns<Project> = (() => {
	const cell = columnsFor<Project>()
	return [
		cell.accessor(project => project.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<Link
					to='/projects/$projectId'
					params={{ projectId: row.original.id }}
					tabIndex={-1}
					className={cn(textLink, 'inline-flex items-center gap-2 font-medium')}
				>
					<IconFolder stroke={1.75} className='size-4 text-muted' />
					{row.original.name}
				</Link>
			),
		}),
		cell.accessor(project => project.tags.join(' '), {
			id: 'tags',
			header: 'Tags',
			cell: ({ row }) => {
				const { tags } = row.original
				if (tags.length === 0) return <span className='text-muted'>-</span>
				return (
					<span className='flex flex-wrap gap-1'>
						{tags.map(tag => (
							<Badge key={tag}>{tag}</Badge>
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
		}),
		cell.accessor(project => project.latest_deployment?.created_at ?? '', {
			id: 'last-deploy',
			header: 'Last deploy',
			cell: ({ row: { original } }) =>
				original.latest_deployment ? (
					<span className='flex items-center gap-2'>
						<Status run value={original.latest_deployment.status} />
						<RelativeTime at={original.latest_deployment.created_at} />
					</span>
				) : (
					<span className='text-muted'>Never</span>
				),
		}),
	]
})()

export const Route = createFileRoute('/projects/')({
	loader: ({ context: { queryClient } }) => preload(queryClient, projectsQuery),
	component: ProjectsPage,
})

function ProjectsPage() {
	const navigate = useNavigate()
	const [creating, setCreating] = useState(false)
	const projects = useQuery(projectsQuery)

	const data = projects.data ?? []
	const services = data.reduce((total, project) => total + project.service_count, 0)
	const latest = data
		.map(project => project.latest_deployment?.created_at)
		.filter(at => at !== undefined)
		.toSorted()
		.at(-1)
	const reading = (value: ReactNode) =>
		projects.data ? value : <PendingReading label='projects' failed={projects.isError} />

	return (
		<Page
			fill
			actions={
				<Button variant='primary' onClick={() => setCreating(true)}>
					<IconPlus size={16} stroke={1.75} />
					New project
				</Button>
			}
		>
			<NewProjectDialog open={creating} onOpenChange={setCreating} />

			{projects.data?.length === 0 ? null : (
				<StatStrip
					className='mb-4'
					items={[
						{ label: 'Services', value: reading(services.toLocaleString('en-US')) },
						{
							label: 'Running',
							value: reading(
								data
									.reduce((total, project) => total + project.running_count, 0)
									.toLocaleString('en-US'),
							),
						},
						{
							label: 'Domains',
							value: reading(
								data
									.reduce((total, project) => total + project.domains.length, 0)
									.toLocaleString('en-US'),
							),
						},
						{
							label: 'Last deploy',
							value: reading(
								latest ? <RelativeTime at={latest} /> : <span className='text-muted'>Never</span>,
							),
						},
					]}
				/>
			)}

			<Section
				title='All projects'
				total={projects.data?.length}
				fill
				actions={<Refresh onClick={() => projects.refetch()} />}
			>
				<DataTable
					data={data}
					columns={projectTableColumns}
					loading={projects.isLoading}
					error={projects.error}
					getRowId={project => project.id}
					onRowClick={project => navigate({ to: '/projects/$projectId', params: { projectId: project.id } })}
					filter='Filter projects'
					empty={
						<EmptyState
							title='No projects yet'
							description='New project creates one, then add services to it.'
						/>
					}
				/>
			</Section>
		</Page>
	)
}
