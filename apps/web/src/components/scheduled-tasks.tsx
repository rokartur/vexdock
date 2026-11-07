import { type ReactNode, useState } from 'react'
import {
	IconClock,
	IconDeviceFloppy,
	IconFileText,
	IconFolder,
	IconPencil,
	IconPlayerPlay,
	IconPlus,
	IconTrash,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import { Switch as ArcSwitch } from '@/components/ui/switch'
import { api, type ScheduledTask, type TaskInput, type TaskRun } from '../lib/api'
import { duration } from '../lib/format'
import { tasksQuery } from '../lib/queries'
import { LogViewer, outputLines } from './log-viewer'
import {
	Button,
	Combo,
	Confirm,
	DetailDialog,
	EmptyState,
	ErrorText,
	ListPlaceholder,
	Field,
	FormDialog,
	IconButton,
	Input,
	Announcement,
	LoadingStatus,
	PendingReading,
	RelativeTime,
	Section,
	Select,
	StatStrip,
	Status,
	Switch,
	Textarea,
	textLink,
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

// Arc's Select reads '' as nothing picked, so Custom needs a value of its own.
const scheduleOptions = [{ label: 'Custom', value: 'custom' }, ...cronPresets]

const timezoneOptions = ['UTC', ...Intl.supportedValuesOf('timeZone').filter(zone => zone !== 'UTC')].map(zone => ({
	value: zone,
	label: zone,
}))

type TaskActions = {
	select: (id: string) => void
	edit: (task: ScheduledTask) => void
	run: (id: string) => void
	toggle: (task: ScheduledTask) => void
	togglingIds: string[]
	remove: (id: string) => void
	removingId: string | undefined
	runningIds: string[]
	failures: Record<string, string>
	/** Off on a service's own tab, where every row has the same owner. */
	owner: boolean
}

/** Arc's agent-routines row: what runs and when, its last run, the schedule switch and Run now. */
function TaskRow({
	task,
	actions: { select, edit, run, toggle, togglingIds, remove, removingId, runningIds, failures, owner },
}: {
	task: ScheduledTask
	actions: TaskActions
}) {
	const running = runningIds.includes(task.id)
	// The switch moves on the click; the PATCH and the refetch behind it take a moment to agree.
	const toggling = togglingIds.includes(task.id)
	const last = task.last_run
	const schedule = cronPresets.find(preset => preset.value === task.schedule)?.label
	return (
		<li className='grid gap-x-4 gap-y-2 px-4 py-3 not-first:border-t not-first:border-border-subtle @2xl:grid-cols-[minmax(0,1fr)_11rem_auto] @2xl:items-center'>
			<div className='grid min-w-0 gap-0.5'>
				<span className='flex min-w-0 items-center gap-2'>
					<span className='truncate font-medium'>{task.name}</span>
					{owner ? (
						<Link
							to='/projects/$projectId/services/$serviceId/tasks'
							params={{ projectId: task.project_id, serviceId: task.service_id }}
							search={{ env: task.environment_id }}
							className={cn(textLink, 'truncate text-xs text-muted')}
						>
							{task.project_name} / {task.service_name}
						</Link>
					) : null}
				</span>
				<span className='flex min-w-0 items-center gap-1.5 text-xs text-muted'>
					<IconClock stroke={1.75} className='size-3.5 shrink-0' />
					<span className='truncate'>
						{schedule ?? <span className='font-mono'>{task.schedule}</span>} · {task.timezone}
					</span>
				</span>
				<span className='truncate font-mono text-xs text-secondary'>{task.command}</span>
			</div>

			<div className='grid justify-items-start gap-0.5 text-xs'>
				<span className='text-secondary'>
					<NextRun task={task} running={running} />
				</span>
				<span className='flex items-center gap-1.5 text-muted'>
					{last ? (
						<>
							<Status dot run value={outcome(last)} />
							<span>
								Last run <RelativeTime at={last.started_at} />
							</span>
							{outcome(last) === 'failed' ? (
								<span className='font-mono text-danger'>exit {last.exit_code}</span>
							) : null}
							{outcome(last) === 'running' ? <span className='font-mono'>running</span> : null}
						</>
					) : (
						'No runs yet'
					)}
				</span>
			</div>

			<div className='flex items-center gap-1.5'>
				<ArcSwitch
					aria-label={`Run ${task.name} on schedule`}
					checked={toggling ? !task.enabled : task.enabled}
					disabled={toggling}
					onCheckedChange={() => toggle(task)}
				/>
				<Button size='sm' loading={running} onClick={() => run(task.id)} aria-label={`Run ${task.name}`}>
					<IconPlayerPlay size={16} stroke={1.75} />
					Run
				</Button>
				<IconButton icon={IconFileText} label={`Show runs of ${task.name}`} onClick={() => select(task.id)} />
				<IconButton icon={IconPencil} label={`Edit ${task.name}`} onClick={() => edit(task)} />
				<Confirm
					title={`Delete ${task.name}?`}
					description='The task and every run it recorded are removed.'
					action='Delete task'
					onConfirm={() => remove(task.id)}
				>
					<IconButton
						icon={IconTrash}
						label={`Delete ${task.name}`}
						loading={removingId === task.id}
						disabled={removingId !== undefined}
					/>
				</Confirm>
			</div>
			{failures[task.id] ? (
				<p role='alert' className='text-xs text-danger @2xl:col-span-3'>
					{failures[task.id]}
				</p>
			) : null}
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
	const [runningIds, setRunningIds] = useState<string[]>([])
	const [togglingIds, setTogglingIds] = useState<string[]>([])
	// Rows run, toggle and delete at the same time, so a failure is kept on the row it belongs to.
	const [failures, setFailures] = useState<Record<string, string>>({})
	const fail = (id: string, verb: string, error: Error) =>
		setFailures(current => ({ ...current, [id]: `Could not ${verb}: ${error.message}` }))
	const clearFailure = (id: string) => setFailures(current => ({ ...current, [id]: '' }))
	// A run that lands changes only its row's dot, so a screen reader hears it here.
	const [announced, setAnnounced] = useState({ text: '', at: 0 })

	const tasks = useQuery({
		...tasksQuery(serviceId),
		// The server computes next_run at fetch time, so a still list would count
		// down to zero and stay there.
		refetchInterval: 30_000,
	})
	// Both lists show the same rows: `['tasks']` on the cross-project page, `['service', id, 'tasks']` on a service tab.
	const invalidate = () => queryClient.invalidateQueries({ predicate: query => query.queryKey.at(-1) === 'tasks' })
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
		// One mutation, many rows: a run holds its request open until the command exits, and other tasks may start meanwhile.
		onMutate: id => {
			clearFailure(id)
			setRunningIds(ids => [...ids, id])
		},
		onError: (error, id) => fail(id, 'run it', error),
		onSettled: (_result, _error, id) => setRunningIds(ids => ids.filter(running => running !== id)),
		onSuccess: async (result, id) => {
			const name = tasks.data?.find(task => task.id === id)?.name ?? 'Task'
			setAnnounced({ text: `${name} ran: ${outcome(result)}`, at: Date.now() })
			await queryClient.invalidateQueries({ queryKey: ['task', id, 'runs'] })
			await invalidate()
		},
	})
	const toggle = useMutation({
		mutationFn: (task: ScheduledTask) => api.updateTask(task.id, { enabled: !task.enabled }),
		onMutate: task => {
			clearFailure(task.id)
			setTogglingIds(ids => [...ids, task.id])
		},
		onError: (error, task) => fail(task.id, task.enabled ? 'pause it' : 'resume it', error),
		onSuccess: invalidate,
		// Cleared after the refetch lands, so the switch never flips back to the old value in between.
		onSettled: (_result, _error, task) => setTogglingIds(ids => ids.filter(toggling => toggling !== task.id)),
	})
	const remove = useMutation({
		mutationFn: api.deleteTask,
		onMutate: clearFailure,
		onError: (error, id) => fail(id, 'delete it', error),
		onSuccess: async (result, id) => {
			if (selected === id) setSelected(null)
			if (form?.id === id) setForm(null)
			await invalidate()
		},
	})

	const actions: TaskActions = {
		select: setSelected,
		edit: task => setForm(taskToForm(task)),
		run: run.mutate,
		toggle: toggle.mutate,
		togglingIds,
		remove: remove.mutate,
		removingId: remove.isPending ? remove.variables : undefined,
		runningIds,
		failures,
		owner: serviceId === undefined,
	}

	const listed = tasks.data ?? []
	const reading = (value: ReactNode) => (tasks.data ? value : <PendingReading label='tasks' />)
	const soonest = listed
		.map(task => task.next_run)
		.filter(at => at !== undefined)
		.toSorted()
		.at(0)

	return (
		<>
			<Announcement message={announced} />
			{serviceId === undefined && (tasks.isLoading || listed.length > 0) ? (
				<StatStrip
					className='mb-4'
					items={[
						{ label: 'Tasks', value: reading(listed.length.toLocaleString('en-US')) },
						{
							label: 'Enabled',
							value: reading(listed.filter(task => task.enabled).length.toLocaleString('en-US')),
						},
						{
							label: 'Failing',
							value: reading(
								listed
									.filter(task => task.last_run && outcome(task.last_run) === 'failed')
									.length.toLocaleString('en-US'),
							),
						},
						{ label: 'Next run', value: reading(soonest ? <RelativeTime at={soonest} future /> : '-') },
					]}
				/>
			) : null}
			<Section
				title='Scheduled tasks'
				total={tasks.data?.length}
				actions={
					serviceId ? (
						<Button variant='primary' size='sm' onClick={() => setForm(emptyTask)}>
							<IconPlus size={16} stroke={1.75} />
							New task
						</Button>
					) : null
				}
			>
				<ErrorText error={tasks.error} />
				{listed.length > 0 ? (
					<ul className='@container rounded-surface border bg-surface'>
						{listed.map(task => (
							<TaskRow key={task.id} task={task} actions={actions} />
						))}
					</ul>
				) : tasks.error ? null : (
					<ListPlaceholder loading={tasks.isLoading} label='Loading tasks'>
						<EmptyState
							icon={IconClock}
							title='No scheduled tasks'
							description={serviceId ? 'Add one with New task.' : 'Add one from a service.'}
						>
							{serviceId ? null : (
								<Button render={<Link to='/projects' />}>
									<IconFolder size={16} stroke={1.75} />
									Open projects
								</Button>
							)}
						</EmptyState>
					</ListPlaceholder>
				)}
			</Section>

			<FormDialog
				open={form !== null}
				onOpenChange={open => !open && setForm(null)}
				title={form?.id ? 'Edit task' : 'New task'}
				action={form?.id ? 'Save task' : 'Add task'}
				icon={form?.id ? IconDeviceFloppy : IconPlus}
				mutation={save}
				onSubmit={() => form && save.mutate(form)}
			>
				{form ? <TaskFormFields form={form} onChange={setForm} /> : null}
			</FormDialog>

			<DetailDialog
				open={selectedTask !== undefined}
				onOpenChange={open => open || setSelected(null)}
				title={selectedTask ? `Runs of ${selectedTask.name}` : ''}
			>
				{selectedTask ? <TaskRuns task={selectedTask} /> : null}
			</DetailDialog>
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

function TaskFormFields({ form, onChange }: { form: TaskForm; onChange: (form: TaskForm) => void }) {
	return (
		<>
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
					placeholder='What it does, for whoever reads this next'
				/>
			</Field>
			<Field label='Schedule' hint='A cron expression, or @daily.'>
				{/* The preset writes the expression rather than replacing it, so the
				    field stays the one source of truth. */}
				<Select
					label='Schedule preset'
					value={cronPresets.some(preset => preset.value === form.schedule) ? form.schedule : 'custom'}
					onChange={schedule => onChange({ ...form, schedule: schedule === 'custom' ? '' : schedule })}
					options={scheduleOptions}
				/>
				<Input
					mono
					required
					value={form.schedule}
					onChange={event => onChange({ ...form, schedule: event.target.value })}
				/>
			</Field>
			<div className='grid gap-x-6 md:grid-cols-2'>
				<Field label='Timezone' hint='The zone those hours are read in.'>
					<Combo
						value={form.timezone}
						onChange={timezone => onChange({ ...form, timezone })}
						options={timezoneOptions}
					/>
				</Field>
				<Field label='Shell' hint='Alpine images have only sh.'>
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
					mono
					required
					rows={4}
					value={form.command}
					onChange={event => onChange({ ...form, command: event.target.value })}
					placeholder='php artisan schedule:run'
				/>
			</Field>
			<Switch label='Enabled' checked={form.enabled} onChange={enabled => onChange({ ...form, enabled })} />
		</>
	)
}

function TaskRuns({ task }: { task: ScheduledTask }) {
	const [openRun, setOpenRun] = useState<string | null>(null)
	const runs = useQuery({
		queryKey: ['task', task.id, 'runs'],
		queryFn: () => api.taskRuns(task.id),
		// A run still going shows partial output; keep reading until it finishes.
		refetchInterval: query => (query.state.data?.some(run => !run.finished_at) ? 5000 : false),
	})

	if (!runs.data) return runs.error ? <ErrorText error={runs.error} /> : <RunsSkeleton />
	const [newest] = runs.data
	if (!newest)
		return (
			<p className='text-sm text-muted'>
				This task has not run yet. Run it from the list to see its output here.
			</p>
		)
	const shown = runs.data.find(candidate => candidate.id === openRun) ?? newest

	return (
		<div>
			{/* A failed poll keeps the log on screen; the error rides above it. */}
			<ErrorText error={runs.error} />
			{/* Up to 20 runs, often minutes apart, so a list named by start time: a segment per run would scroll. The
			    fixed width holds the longest label, since the popup is as wide as the trigger. */}
			<div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
				<Select
					label='Run'
					value={shown.id}
					onChange={setOpenRun}
					options={runs.data.map(item => ({ value: item.id, label: runLabel(item) }))}
					className='w-64'
				/>
				<RunOutcome run={shown} />
			</div>
			<div className='mt-3'>
				<LogViewer key={shown.id} lines={outputLines(shown.output)} inset className='h-64' />
			</div>
		</div>
	)
}

function NextRun({ task, running }: { task: ScheduledTask; running: boolean }) {
	if (running) return 'Running'
	if (!task.enabled) return 'Paused'
	if (!task.next_run) return 'No upcoming run'
	return (
		<>
			Next run <RelativeTime at={task.next_run} future />
		</>
	)
}

function runLabel(run: TaskRun) {
	const started = new Date(run.started_at).toLocaleString([], {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
	})
	const result = outcome(run)
	return result === 'success' ? started : `${started}, ${result}`
}

/** A run without a finish stamp is still going; its exit code is the -1 placeholder until then. */
function outcome(run: TaskRun) {
	if (!run.finished_at) return 'running'
	return run.exit_code === 0 ? 'success' : 'failed'
}

/** The run picker and its log while the runs load, held still in the frames they fill. */
function RunsSkeleton() {
	return (
		<div className='grid gap-3'>
			<LoadingStatus label='Loading runs' />
			<span aria-hidden className='h-control-md w-64 max-w-full rounded-control border bg-surface' />
			<span aria-hidden className='h-64 rounded-[max(6px,calc(var(--radius-surface)-16px))] border bg-surface' />
		</div>
	)
}

function RunOutcome({ run }: { run: TaskRun }) {
	if (!run.finished_at) return <span className='font-mono text-muted'>running</span>
	return (
		<span className='font-mono text-muted'>
			{duration(run.started_at, run.finished_at)}
			{run.exit_code === 0 ? null : <span className='text-danger'> exit {run.exit_code}</span>}
		</span>
	)
}
