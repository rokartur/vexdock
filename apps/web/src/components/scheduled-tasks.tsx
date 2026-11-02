import { useState } from 'react'
import {
	IconClock,
	IconDeviceFloppy,
	IconFileText,
	IconPencil,
	IconPlayerPlay,
	IconPlus,
	IconTrash,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Switch as ArcSwitch } from '@/components/ui/switch'
import { api, type ScheduledTask, type TaskInput } from '../lib/api'
import { duration, since } from '../lib/format'
import { tasksQuery } from '../lib/queries'
import { LogViewer } from './log-viewer'
import {
	Button,
	Confirm,
	EmptyState,
	ErrorText,
	Field,
	IconButton,
	Input,
	RelativeTime,
	Section,
	Segmented,
	Select,
	StatStrip,
	Status,
	Switch,
	Textarea,
} from './primitives'

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

const scheduleOptions = [{ label: 'Custom', value: '' }, ...cronPresets]

const timezoneOptions = ['UTC', ...Intl.supportedValuesOf('timeZone').filter(zone => zone !== 'UTC')].map(zone => ({
	value: zone,
	label: zone,
}))

type TaskActions = {
	select: (id: string) => void
	edit: (task: ScheduledTask) => void
	run: (id: string) => void
	toggle: (task: ScheduledTask) => void
	remove: (id: string) => void
	runningId: string | null
	/** Off on a service's own tab, where every row has the same owner. */
	owner: boolean
}

/** Arc's agent-routines row: what runs and when, its last run, the schedule switch and Run now. */
function TaskRow({
	task,
	actions: { select, edit, run, toggle, remove, runningId, owner },
}: {
	task: ScheduledTask
	actions: TaskActions
}) {
	const running = runningId === task.id
	const last = task.last_run
	const schedule = cronPresets.find(preset => preset.value === task.schedule)?.label
	return (
		<li className='grid gap-x-4 gap-y-2 px-4 py-3 not-first:border-t not-first:border-border-subtle md:grid-cols-[minmax(0,1fr)_11rem_auto] md:items-center'>
			<div className='grid min-w-0 gap-0.5'>
				<span className='flex min-w-0 items-center gap-2'>
					<span className='truncate font-medium'>{task.name}</span>
					{owner ? (
						<Link
							to='/projects/$projectId/services/$serviceId/tasks'
							params={{ projectId: task.project_id, serviceId: task.service_id }}
							className='truncate text-xs text-muted underline-offset-4 hover:underline'
						>
							{task.project_name} / {task.service_name}
						</Link>
					) : null}
				</span>
				<span className='flex min-w-0 items-center gap-1.5 text-xs text-muted'>
					<IconClock className='size-3.5 shrink-0' />
					<span className='truncate'>
						{schedule ?? <span className='font-mono'>{task.schedule}</span>} · {task.timezone}
					</span>
				</span>
				<span className='truncate font-mono text-xs text-secondary'>{task.command}</span>
			</div>

			<button
				type='button'
				onClick={() => select(task.id)}
				className='-mx-2 grid justify-items-start gap-0.5 justify-self-start rounded-control px-2 py-1 text-left text-xs hover:bg-surface-muted md:mx-0'
			>
				<span className='text-secondary'>
					{running ? (
						'Running'
					) : task.enabled ? (
						task.next_run ? (
							<>
								Next run <RelativeTime at={task.next_run} />
							</>
						) : (
							'Never comes round'
						)
					) : (
						'Paused'
					)}
				</span>
				<span className='flex items-center gap-1.5 text-muted'>
					{last ? (
						<>
							<Status dot value={last.exit_code === 0 ? 'success' : 'failed'} />
							<RelativeTime at={last.started_at} />
							<span className='font-mono'>
								{last.finished_at ? duration(last.started_at, last.finished_at) : 'running'}
							</span>
							{last.exit_code === 0 ? null : (
								<span className='font-mono text-danger'>exit {last.exit_code}</span>
							)}
						</>
					) : (
						'No runs yet'
					)}
				</span>
			</button>

			<div className='flex items-center gap-1.5'>
				<ArcSwitch
					aria-label={`Run ${task.name} on schedule`}
					checked={task.enabled}
					onCheckedChange={() => toggle(task)}
				/>
				<Button disabled={runningId !== null} onClick={() => run(task.id)}>
					<IconPlayerPlay />
					{running ? 'Running…' : 'Run'}
				</Button>
				<IconButton icon={IconFileText} label='Runs' onClick={() => select(task.id)} />
				<IconButton icon={IconPencil} label='Edit' onClick={() => edit(task)} />
				{/* Deleting a task takes its whole run history with it, so it asks first. */}
				<Confirm
					title={`Delete ${task.name}?`}
					description='The task and every run it recorded are removed.'
					onConfirm={() => remove(task.id)}
				>
					<IconButton icon={IconTrash} label='Delete' />
				</Confirm>
			</div>
		</li>
	)
}

/**
 * Cron jobs that exec inside a service's container. The manager ticks once a minute, reads each expression in the
 * task's own timezone, and skips a task whose previous run is still going. Without a service this lists every task
 * on the server, with the owner column and without the create button.
 */
export function ScheduledTasks({ serviceId }: { serviceId?: string }) {
	const queryClient = useQueryClient()
	// A form is open exactly when there is one to edit, so one state covers both.
	const [form, setForm] = useState<TaskForm | null>(null)
	const [selected, setSelected] = useState<string | null>(null)

	const tasks = useQuery({
		...tasksQuery(serviceId),
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
		mutationFn: api.runTask,
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
		mutationFn: api.deleteTask,
		onSuccess: async (_result, id) => {
			if (selected === id) setSelected(null)
			if (form?.id === id) setForm(null)
			await invalidate()
		},
	})

	// A manual run holds the request open until the command exits, so the row has
	// to say so; a second click would only earn a 409.
	const actions: TaskActions = {
		select: setSelected,
		edit: task => setForm(taskToForm(task)),
		run: run.mutate,
		toggle: toggle.mutate,
		remove: remove.mutate,
		runningId: run.isPending ? run.variables : null,
		owner: serviceId === undefined,
	}

	const listed = tasks.data ?? []
	const soonest = listed
		.map(task => task.next_run)
		.filter(at => at !== null)
		.toSorted()
		.at(0)

	return (
		<>
			{serviceId === undefined && listed.length > 0 ? (
				<StatStrip
					className='mb-4'
					items={[
						{ label: 'Tasks', value: listed.length },
						{ label: 'Enabled', value: listed.filter(task => task.enabled).length },
						{
							label: 'Failing',
							value: listed.filter(task => task.last_run && task.last_run.exit_code !== 0).length,
						},
						{ label: 'Next run', value: soonest ? <RelativeTime at={soonest} /> : '-' },
					]}
				/>
			) : null}
			<Section
				title='Scheduled tasks'
				actions={
					serviceId ? (
						<Button variant='primary' onClick={() => setForm(emptyTask)}>
							<IconPlus />
							New task
						</Button>
					) : null
				}
			>
				<ErrorText error={tasks.error} />
				{listed.length === 0 ? (
					<div className='rounded-surface border bg-surface'>
						<EmptyState
							icon={IconClock}
							title={tasks.isLoading ? 'Loading tasks' : 'No scheduled tasks'}
							description={serviceId ? undefined : 'Add one from a service.'}
						/>
					</div>
				) : (
					<ul className='rounded-surface border bg-surface'>
						{listed.map(task => (
							<TaskRow key={task.id} task={task} actions={actions} />
						))}
					</ul>
				)}
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
				<DialogContent title={form?.id ? 'Edit task' : 'New task'} className='[--dialog-width:32rem]'>
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
				<DialogContent
					title={selectedTask ? `Runs of ${selectedTask.name}` : ''}
					className='[--dialog-width:42rem]'
				>
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
				<Input
					required
					value={form.name}
					onChange={event => onChange({ ...form, name: event.target.value })}
					placeholder='nightly backup'
				/>
			</Field>
			<Field label='Description'>
				<Input
					value={form.description}
					onChange={event => onChange({ ...form, description: event.target.value })}
					placeholder='what it does, for whoever reads this next'
				/>
			</Field>
			<Field label='Schedule' hint='cron, or @daily'>
				{/* The preset writes the expression rather than replacing it, so the
				    field stays the one source of truth. */}
				<Select
					value={cronPresets.some(preset => preset.value === form.schedule) ? form.schedule : ''}
					onChange={schedule => onChange({ ...form, schedule })}
					options={scheduleOptions}
				/>
				<Input
					required
					value={form.schedule}
					onChange={event => onChange({ ...form, schedule: event.target.value })}
					spellCheck={false}
				/>
			</Field>
			<div className='grid grid-cols-2 gap-3'>
				<Field label='Timezone' hint='the zone those hours are read in'>
					<Select
						value={form.timezone}
						onChange={timezone => onChange({ ...form, timezone })}
						options={timezoneOptions}
					/>
				</Field>
				<Field label='Shell' hint='sh is the one Alpine images have'>
					<Select
						value={form.shell}
						onChange={shell => onChange({ ...form, shell })}
						options={[
							{ value: 'sh', label: 'sh' },
							{ value: 'bash', label: 'bash' },
						]}
					/>
				</Field>
			</div>
			<Field label='Command'>
				<Textarea
					required
					rows={4}
					value={form.command}
					onChange={event => onChange({ ...form, command: event.target.value })}
					placeholder='php artisan schedule:run'
					spellCheck={false}
				/>
			</Field>
			<Switch label='Enabled' checked={form.enabled} onChange={enabled => onChange({ ...form, enabled })} />
			<ErrorText error={error} />
			<div className='mt-4 flex justify-end'>
				<Button type='submit' variant='primary' disabled={saving}>
					{form.id ? <IconDeviceFloppy /> : <IconPlus />}
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
				<Segmented
					label='Runs'
					value={shown?.id ?? ''}
					onChange={setOpenRun}
					options={runs.data.map(item => ({
						value: item.id,
						label: since(item.started_at),
						accessory: (
							<span className={item.exit_code === 0 ? 'font-mono text-muted' : 'font-mono text-danger'}>
								{item.finished_at ? duration(item.started_at, item.finished_at) : 'running'}
							</span>
						),
					}))}
				/>
			) : (
				<p className='text-sm text-muted'>This task has not run yet.</p>
			)}
			{shown ? (
				<div className='mt-3'>
					<LogViewer
						key={shown.id}
						lines={shown.output
							.split('\n')
							.filter(Boolean)
							.map(text => ({ stream: 'stdout', text }))}
						className='h-64'
					/>
				</div>
			) : null}
		</div>
	)
}
