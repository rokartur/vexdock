import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, type ScheduledTask, type TaskInput } from '../lib/api'
import { duration, since, until } from '../lib/format'
import { type Columns, DataTable, columnsFor } from './data-table'
import { Button, Check, ErrorText, Field, Section } from './primitives'

/** A task being written. `id` is null while it is still a new one. */
type TaskForm = TaskInput & { id: string | null }

const emptyTask: TaskForm = {
	id: null,
	name: '',
	description: '',
	schedule: '0 3 * * *',
	// The browser's own zone, because "3am" means 3am where the person sits.
	timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	command: '',
	shell: 'sh',
	enabled: true,
}

/** The schedules people actually write, so most tasks never touch the field. */
const cronPresets = [
	{ label: 'Every 5 minutes', value: '*/5 * * * *' },
	{ label: 'Every 15 minutes', value: '*/15 * * * *' },
	{ label: 'Every hour', value: '0 * * * *' },
	{ label: 'Every day at midnight', value: '0 0 * * *' },
	{ label: 'Every day at 3am', value: '0 3 * * *' },
	{ label: 'Every Monday at 9am', value: '0 9 * * 1' },
	{ label: 'First of the month', value: '0 0 1 * *' },
]

const timezones = Intl.supportedValuesOf('timeZone')

type TaskActions = {
	select: (id: string) => void
	edit: (task: ScheduledTask) => void
	run: (id: string) => void
	toggle: (task: ScheduledTask) => void
	remove: (id: string) => void
	runningId: string | null
	confirming: string | null
	setConfirming: (id: string | null) => void
	/** Off on a service's own tab, where every row has the same owner. */
	owner: boolean
}

function taskColumns({
	select,
	edit,
	run,
	toggle,
	remove,
	runningId,
	confirming,
	setConfirming,
	owner,
}: TaskActions): Columns<ScheduledTask> {
	const cell = columnsFor<ScheduledTask>()
	const ownerColumn = cell.accessor(task => `${task.project_name} ${task.service_name}`, {
		id: 'service',
		header: 'Service',
		cell: ({ row }) => (
			<>
				<Link
					to='/projects/$projectId/services/$serviceId'
					params={{ projectId: row.original.project_id, serviceId: row.original.service_id }}
					search={{ tab: 'tasks' }}
					className='hover:underline'
				>
					{row.original.service_name}
				</Link>
				<span className='block text-label text-muted-foreground'>{row.original.project_name}</span>
			</>
		),
	})
	return [
		cell.accessor(task => task.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<>
					{row.original.name}
					{row.original.enabled ? null : <span className='ml-2 text-label text-muted-foreground'>off</span>}
					{row.original.description ? (
						<span className='block max-w-64 truncate text-label text-muted-foreground'>
							{row.original.description}
						</span>
					) : null}
				</>
			),
		}),
		...(owner ? [ownerColumn] : []),
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
			cell: ({ row }) => <span className='block max-w-80 truncate'>{row.original.command}</span>,
		}),
		cell.accessor(task => task.last_run?.started_at ?? '', {
			id: 'last-run',
			header: 'Last run',
			// The last run is the way into the history: clicking what a task did last
			// shows everything it has done.
			cell: ({ row }) => {
				const last = row.original.last_run
				if (!last) return <span className='text-muted-foreground'>never</span>
				return (
					<button
						type='button'
						className={`cursor-pointer hover:underline ${last.exit_code === 0 ? '' : 'text-red-400'}`}
						onClick={() => select(row.original.id)}
					>
						{since(last.started_at)}
						<span className='ml-2 font-mono text-label text-muted-foreground'>
							{last.finished_at ? duration(last.started_at, last.finished_at) : 'running'}
						</span>
						{last.exit_code === 0 ? '' : ` · exit ${last.exit_code}`}
					</button>
				)
			},
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row: { original } }) =>
				// Deleting a task takes its whole run history with it, so it asks first.
				confirming === original.id ? (
					<div className='flex justify-end gap-2'>
						<Button variant='danger' onClick={() => remove(original.id)}>
							confirm delete
						</Button>
						<Button variant='ghost' onClick={() => setConfirming(null)}>
							cancel
						</Button>
					</div>
				) : (
					<div className='flex justify-end gap-2'>
						<Button variant='ghost' onClick={() => select(original.id)}>
							logs
						</Button>
						<Button disabled={runningId !== null} variant='ghost' onClick={() => run(original.id)}>
							{runningId === original.id ? 'running' : 'run now'}
						</Button>
						<Button variant='ghost' onClick={() => edit(original)}>
							edit
						</Button>
						<Button variant='ghost' onClick={() => toggle(original)}>
							{original.enabled ? 'disable' : 'enable'}
						</Button>
						<Button variant='ghost' onClick={() => setConfirming(original.id)}>
							delete
						</Button>
					</div>
				),
		}),
	]
}

/**
 * Cron jobs that exec inside a service's container, with the same reach as the
 * terminal tab. The manager ticks once a minute, reads each expression in the
 * task's own timezone, and skips a task whose previous run is still going.
 *
 * Without a service this is every task on the server, which is the same table
 * plus the column naming the owner, minus the button that would not know which
 * service to create in.
 */
export function ScheduledTasks({ serviceId }: { serviceId?: string }) {
	const queryClient = useQueryClient()
	// A form is open exactly when there is one to edit, so one state covers both.
	const [form, setForm] = useState<TaskForm | null>(null)
	const [selected, setSelected] = useState<string | null>(null)
	const [confirming, setConfirming] = useState<string | null>(null)

	const queryKey = serviceId ? ['service', serviceId, 'tasks'] : ['tasks']
	const tasks = useQuery({
		queryKey,
		queryFn: () => (serviceId ? api.serviceTasks(serviceId) : api.tasks()),
		// The server computes next_run at fetch time, so a still list would count
		// down to zero and stay there.
		refetchInterval: 30_000,
	})
	// Editing from the cross-project page changes a row the service tab also
	// shows, and the other way round, so both lists go stale together.
	const invalidate = async () => {
		await queryClient.invalidateQueries({ queryKey: ['tasks'] })
		if (serviceId) await queryClient.invalidateQueries({ queryKey: ['service', serviceId, 'tasks'] })
	}
	const selectedTask = tasks.data?.find(task => task.id === selected)

	const save = useMutation({
		mutationFn: ({ id, ...body }: TaskForm) => {
			if (id) return api.updateTask(id, body)
			// The cross-project list hides the button that would land here.
			if (!serviceId) throw new Error('a new task needs a service')
			return api.createTask(serviceId, body)
		},
		onSuccess: async () => {
			setForm(null)
			await invalidate()
		},
	})
	const run = useMutation({
		mutationFn: (id: string) => api.runTask(id),
		onSuccess: async (_result, id) => {
			setSelected(id)
			await queryClient.invalidateQueries({ queryKey: ['task', id, 'runs'] })
			await invalidate()
		},
	})
	const toggle = useMutation({
		mutationFn: (task: ScheduledTask) => api.updateTask(task.id, { enabled: !task.enabled }),
		onSuccess: invalidate,
	})
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteTask(id),
		onSuccess: async (_result, id) => {
			setConfirming(null)
			if (selected === id) setSelected(null)
			if (form?.id === id) setForm(null)
			await invalidate()
		},
	})

	const { mutate: runTask } = run
	const { mutate: toggleTask } = toggle
	const { mutate: removeTask } = remove
	// A manual run holds the request open until the command exits, so the row has
	// to say so; a second click would only earn a 409.
	const runningId = run.isPending ? run.variables : null
	const columns = useMemo(
		() =>
			taskColumns({
				select: setSelected,
				edit: task => setForm(taskToForm(task)),
				run: runTask,
				toggle: toggleTask,
				remove: removeTask,
				runningId,
				confirming,
				setConfirming,
				owner: serviceId === undefined,
			}),
		[runTask, toggleTask, removeTask, runningId, confirming, serviceId],
	)

	return (
		<>
			<Section
				title='Scheduled tasks'
				description={serviceId ? 'run inside this service’s container' : 'across every project'}
				actions={
					serviceId ? (
						<Button variant='primary' onClick={() => setForm(emptyTask)}>
							New task
						</Button>
					) : null
				}
			>
				<DataTable
					data={tasks.data ?? []}
					columns={columns}
					loading={tasks.isLoading}
					getRowId={task => task.id}
					empty={serviceId ? 'No scheduled tasks.' : 'No scheduled tasks. Add one from a service.'}
				/>
				<ErrorText error={run.error ?? toggle.error ?? remove.error} />
			</Section>

			<Dialog
				open={form !== null}
				onOpenChange={open => {
					if (open) return
					setForm(null)
					// Otherwise the next task opened inherits this one's failure.
					save.reset()
				}}
			>
				<DialogContent className='sm:max-w-lg'>
					<DialogHeader>
						<DialogTitle>{form?.id ? 'Edit task' : 'New task'}</DialogTitle>
					</DialogHeader>
					{form ? (
						<TaskFormFields
							form={form}
							onChange={setForm}
							onSubmit={() => save.mutate(form)}
							saving={save.isPending}
							error={save.error}
						/>
					) : null}
				</DialogContent>
			</Dialog>

			<Dialog
				open={selectedTask !== undefined}
				onOpenChange={open => {
					if (!open) setSelected(null)
				}}
			>
				<DialogContent className='sm:max-w-2xl'>
					<DialogHeader>
						<DialogTitle>{selectedTask ? `Runs of ${selectedTask.name}` : ''}</DialogTitle>
					</DialogHeader>
					{selectedTask ? <TaskRuns task={selectedTask} /> : null}
				</DialogContent>
			</Dialog>
		</>
	)
}

/** Only the columns a task's form writes; the rest would fail the PATCH body. */
const taskToForm = ({
	id,
	name,
	description,
	schedule,
	timezone,
	command,
	shell,
	enabled,
}: ScheduledTask): TaskForm => ({ id, name, description, schedule, timezone, command, shell, enabled })

function TaskFormFields({
	form,
	onChange,
	onSubmit,
	saving,
	error,
}: {
	form: TaskForm
	onChange: (form: TaskForm) => void
	onSubmit: () => void
	saving: boolean
	error: unknown
}) {
	return (
		<form
			onSubmit={event => {
				event.preventDefault()
				onSubmit()
			}}
		>
			<Field label='Name'>
				<input
					required
					value={form.name}
					onChange={event => onChange({ ...form, name: event.target.value })}
					placeholder='nightly backup'
				/>
			</Field>
			<Field label='Description'>
				<input
					value={form.description}
					onChange={event => onChange({ ...form, description: event.target.value })}
					placeholder='what it does, for whoever reads this next'
				/>
			</Field>
			<Field label='Schedule' hint='cron, or @daily'>
				{/* The preset writes the expression rather than replacing it, so the
				    field stays the one source of truth. */}
				<select
					value={cronPresets.some(preset => preset.value === form.schedule) ? form.schedule : ''}
					onChange={event => onChange({ ...form, schedule: event.target.value })}
				>
					<option value=''>Custom</option>
					{cronPresets.map(preset => (
						<option key={preset.value} value={preset.value}>
							{preset.label}
						</option>
					))}
				</select>
				<input
					required
					value={form.schedule}
					onChange={event => onChange({ ...form, schedule: event.target.value })}
					className='mt-1.5 font-mono'
				/>
			</Field>
			<div className='grid grid-cols-2 gap-3'>
				<Field label='Timezone' hint='the zone those hours are read in'>
					<select
						value={form.timezone}
						onChange={event => onChange({ ...form, timezone: event.target.value })}
					>
						<option value='UTC'>UTC</option>
						{timezones.map(zone => (
							<option key={zone} value={zone}>
								{zone}
							</option>
						))}
					</select>
				</Field>
				<Field label='Shell' hint='sh is the one Alpine images have'>
					<select
						value={form.shell}
						onChange={event => onChange({ ...form, shell: event.target.value === 'bash' ? 'bash' : 'sh' })}
					>
						<option value='sh'>sh</option>
						<option value='bash'>bash</option>
					</select>
				</Field>
			</div>
			<Field label='Command'>
				<textarea
					required
					rows={4}
					value={form.command}
					onChange={event => onChange({ ...form, command: event.target.value })}
					placeholder='php artisan schedule:run'
					className='font-mono text-body'
					spellCheck={false}
				/>
			</Field>
			<Check label='Enabled' checked={form.enabled} onChange={enabled => onChange({ ...form, enabled })} />
			<ErrorText error={error} />
			<div className='mt-3'>
				<Button type='submit' variant='primary' disabled={saving}>
					{form.id ? 'Save task' : 'Add task'}
				</Button>
			</div>
		</form>
	)
}

/** Recent executions of one task, newest first, with the output it produced. */
function TaskRuns({ task }: { task: ScheduledTask }) {
	const [openRun, setOpenRun] = useState<string | null>(null)
	const runs = useQuery({ queryKey: ['task', task.id, 'runs'], queryFn: () => api.taskRuns(task.id) })

	const shown = runs.data?.find(candidate => candidate.id === openRun) ?? runs.data?.[0]

	return (
		<div>
			{runs.data?.length ? (
				<div className='flex flex-wrap gap-2'>
					{runs.data.map(item => (
						<button
							key={item.id}
							type='button'
							onClick={() => setOpenRun(item.id)}
							className={`cursor-pointer rounded-md border px-2 py-1 text-label ${
								item.id === shown?.id ? 'border-foreground' : 'border-border text-muted-foreground'
							}`}
						>
							<span className={item.exit_code === 0 ? undefined : 'text-red-400'}>
								{since(item.started_at)}
							</span>
							<span className='ml-2 font-mono text-muted-foreground'>
								{item.finished_at ? duration(item.started_at, item.finished_at) : 'running'}
							</span>
						</button>
					))}
				</div>
			) : (
				<p className='text-body text-muted-foreground'>This task has not run yet.</p>
			)}
			{shown ? (
				<pre className='mt-3 max-h-96 overflow-auto rounded-lg border border-border p-2 font-mono text-body whitespace-pre-wrap'>
					{shown.output || 'No output.'}
				</pre>
			) : null}
		</div>
	)
}
