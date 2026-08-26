import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Page, Refresh, Section } from '../components/primitives'
import { api, type TaskWithOwner } from '../lib/api'
import { since, until } from '../lib/format'

export const Route = createFileRoute('/tasks')({ component: Tasks })

const taskTableColumns: Columns<TaskWithOwner> = (() => {
	const cell = columnsFor<TaskWithOwner>()
	return [
		cell.accessor(task => task.name, {
			id: 'name',
			header: 'Task',
			// The row links to the service tab, which is where a task is run,
			// edited and read. This page answers what is due and what broke.
			cell: ({ row }) => (
				<>
					<Link
						to='/projects/$projectId/services/$serviceId'
						params={{ projectId: row.original.project_id, serviceId: row.original.service_id }}
						search={{ tab: 'tasks' }}
						className='hover:underline'
					>
						{row.original.name}
					</Link>
					{row.original.enabled ? null : <span className='ml-2 text-label text-muted-foreground'>off</span>}
					{row.original.description ? (
						<span className='block max-w-64 truncate text-label text-muted-foreground'>
							{row.original.description}
						</span>
					) : null}
				</>
			),
		}),
		cell.accessor(task => `${task.project_name} ${task.service_name}`, {
			id: 'service',
			header: 'Service',
			cell: ({ row }) => (
				<>
					{row.original.service_name}
					<span className='block text-label text-muted-foreground'>{row.original.project_name}</span>
				</>
			),
		}),
		cell.accessor(task => task.schedule, {
			id: 'schedule',
			header: 'Schedule',
			cell: ({ row }) => (
				<>
					<span className='font-mono'>{row.original.schedule}</span>
					<span className='block text-label text-muted-foreground'>{row.original.timezone}</span>
				</>
			),
		}),
		cell.accessor(task => task.next_run ?? '', {
			id: 'next-run',
			header: 'Next run',
			cell: ({ row }) =>
				row.original.next_run ? (
					until(row.original.next_run)
				) : (
					<span className='text-muted-foreground'>{row.original.enabled ? 'never' : 'paused'}</span>
				),
		}),
		cell.accessor(task => task.command, {
			id: 'command',
			header: 'Command',
			meta: { mono: true },
			cell: ({ row }) => <span className='block max-w-72 truncate'>{row.original.command}</span>,
		}),
		cell.accessor(task => task.last_run?.started_at ?? '', {
			id: 'last-run',
			header: 'Last run',
			cell: ({ row }) => {
				const last = row.original.last_run
				if (!last) return <span className='text-muted-foreground'>never</span>
				return <span className={last.exit_code === 0 ? '' : 'text-red-400'}>{since(last.started_at)}</span>
			},
		}),
	]
})()

function Tasks() {
	const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks, refetchInterval: 30_000 })
	const data = tasks.data ?? []
	const failing = data.filter(task => task.last_run && task.last_run.exit_code !== 0).length

	return (
		<Page>
			<Section
				title='Scheduled tasks'
				description={
					failing
						? `${data.length} across every project, ${failing} failing`
						: `${data.length} across every project`
				}
				actions={<Refresh onClick={() => tasks.refetch()} busy={tasks.isFetching} />}
			>
				<DataTable
					data={data}
					columns={taskTableColumns}
					loading={tasks.isLoading}
					getRowId={task => task.id}
					empty='No scheduled tasks. Add one from a service.'
					fillHeight
				/>
			</Section>
		</Page>
	)
}
