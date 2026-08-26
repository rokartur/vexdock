import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { LogViewer } from '../components/log-viewer'
import { MetricCard, type Point, ratesOf, seriesOf, useHistory } from '../components/metric-chart'
import { Button, Cells, ErrorText, Fact, Facts, Field, Section } from '../components/primitives'
import { Terminal } from '../components/terminal'
import { api, type ContainerStats, type ScheduledTask, type Service, type ServicePoint } from '../lib/api'
import { fromDotenv, toDotenv } from '../lib/dotenv'
import { bytes, duration, percent, since } from '../lib/format'
import { useEventSource } from '../lib/sse'

export const Route = createFileRoute('/projects/$projectId/services/$serviceId')({
	component: ServiceDetail,
	// The open tab lives in the URL so a link can point straight at the logs.
	validateSearch: (search: Record<string, unknown>): { tab?: Tab } => (isTab(search.tab) ? { tab: search.tab } : {}),
})

type Tab = 'overview' | 'environment' | 'logs' | 'terminal' | 'tasks' | 'settings'

const isTab = (value: unknown): value is Tab =>
	['overview', 'environment', 'logs', 'terminal', 'tasks', 'settings'].includes(value as string)

/**
 * A service the project's own compose file declares is described, never
 * rewritten: it has no environment of its own and deleting it means editing
 * that file.
 */
const tabsFor = (service: Service | undefined): Tab[] =>
	service && service.source_type !== 'derived'
		? ['overview', 'environment', 'logs', 'terminal', 'tasks', 'settings']
		: ['overview', 'logs', 'terminal', 'tasks']

/**
 * Recorded buckets and live SSE samples share one shape, stamped in
 * milliseconds. Only live samples carry a process count; it is not recorded.
 */
type Sample = ServicePoint & { pids?: number }

const toMillis = (point: ServicePoint): Sample => ({ ...point, at: point.at * 1000 })

/** Latest per-second rate, or zero while the window is still filling. */
function latest(rates: Point[]) {
	return rates.at(-1)?.value ?? 0
}

function ServiceDetail() {
	const { projectId, serviceId } = Route.useParams()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const { tab = 'overview' } = Route.useSearch()
	const setTab = (next: Tab) =>
		navigate({ to: '.', search: prev => ({ ...prev, tab: next === 'overview' ? undefined : next }), replace: true })
	const [stats, setStats] = useState<Sample | null>(null)

	const service = useQuery({
		queryKey: ['service', serviceId],
		queryFn: () => api.service(serviceId),
		refetchInterval: 5000,
	})
	const recorded = useQuery({
		queryKey: ['service', serviceId, 'metrics'],
		queryFn: () => api.serviceMetrics(serviceId, '30m'),
	})

	const running = service.data?.state === 'running'
	useEventSource(running ? `/api/services/${serviceId}/stats` : null, {
		stats: data => setStats({ ...(data as ContainerStats), at: Date.now() }),
	})

	const history = useHistory(
		stats,
		useMemo(() => (recorded.data ?? []).map(toMillis), [recorded.data]),
	)
	const received = ratesOf(history, sample => sample.network_rx)
	const sent = ratesOf(history, sample => sample.network_tx)
	const read = ratesOf(history, sample => sample.block_read)
	const written = ratesOf(history, sample => sample.block_write)
	// Until the first live sample lands, the newest recorded bucket is the reading.
	const current = stats ?? history.at(-1)

	const act = useMutation({
		mutationFn: (action: 'start' | 'stop' | 'restart') => api.serviceAction(serviceId, action),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', serviceId] }),
	})
	const deploy = useMutation({
		mutationFn: () => api.deployService(serviceId),
		onSuccess: async deployment => {
			await queryClient.invalidateQueries({ queryKey: ['service', serviceId] })
			await navigate({ to: '/deployments/$deploymentId', params: { deploymentId: deployment.id } })
		},
	})

	const tabs = tabsFor(service.data)
	const canDeploy = Boolean(service.data && service.data.source_type !== 'unconfigured')

	return (
		<>
			{/* The name and its state live in the header trail's service picker. */}
			<div className='mb-4 flex flex-wrap justify-end gap-2'>
				<Button variant='primary' onClick={() => deploy.mutate()} disabled={!canDeploy || deploy.isPending}>
					{deploy.isPending ? 'Starting…' : 'Deploy'}
				</Button>
				<Button onClick={() => act.mutate('restart')} disabled={!running}>
					Restart
				</Button>
				<Button onClick={() => act.mutate('stop')} disabled={!running || act.isPending}>
					Stop
				</Button>
			</div>
			<ErrorText error={deploy.error ?? act.error} />

			<nav className='mb-4 flex gap-4 border-b border-border'>
				{tabs.map(item => (
					<button
						key={item}
						type='button'
						onClick={() => setTab(item)}
						className={`-mb-px border-b px-0.5 pb-1.5 text-body capitalize ${
							tab === item
								? 'border-foreground text-foreground'
								: 'border-transparent text-muted-foreground hover:text-foreground'
						}`}
					>
						{item}
					</button>
				))}
			</nav>

			{tab === 'overview' ? (
				<>
					{service.data?.type === 'database' ? <DatabasePanels serviceId={serviceId} /> : null}
					<Section title='Overview'>
						<Cells>
							<MetricCard
								label='CPU'
								value={current ? percent(current.cpu_percent) : '-'}
								series={[seriesOf(history, sample => sample.cpu_percent)]}
								max={100}
								format={([cpu]) => percent(cpu)}
							/>
							<MetricCard
								label='Memory'
								value={current ? bytes(current.memory_usage) : '-'}
								series={[seriesOf(history, sample => sample.memory_usage)]}
								max={current?.memory_limit}
								format={([used]) => bytes(used)}
								hint={current ? `of ${bytes(current.memory_limit)}` : undefined}
							/>
							<MetricCard
								label='Network'
								value={`${bytes(latest(received))} / ${bytes(latest(sent))}`}
								series={[received, sent]}
								format={([rx, tx]) => `${bytes(rx)} / ${bytes(tx)}`}
								hint='rx / tx per second'
							/>
							<MetricCard
								label='Block i/o'
								value={`${bytes(latest(read))} / ${bytes(latest(written))}`}
								series={[read, written]}
								format={([r, w]) => `${bytes(r)} / ${bytes(w)}`}
								hint='read / write per second'
							/>
						</Cells>
						<div className='mt-4 grid items-start gap-x-7 lg:grid-cols-2'>
							<Facts>
								<Fact label='Image' value={service.data?.running_image || service.data?.image || '-'} />
								<Fact
									label='Created'
									value={service.data?.created_unix ? since(service.data.created_unix) : '-'}
								/>
								<Fact label='Restarts' value={service.data?.restart_count ?? 0} />
							</Facts>
							<Facts>
								<Fact label='Health' value={service.data?.health || 'no healthcheck'} />
								<Fact label='PIDs' value={stats?.pids ?? '-'} />
								<Fact label='Container' value={service.data?.container_id?.slice(0, 12) || '-'} />
							</Facts>
						</div>
					</Section>
				</>
			) : null}

			{tab === 'environment' ? <ServiceEnvironment serviceId={serviceId} /> : null}

			{tab === 'logs' ? <LogViewer url={`/api/services/${serviceId}/logs`} /> : null}

			{tab === 'terminal' ? (
				running ? (
					<Terminal url={terminalUrl(serviceId)} />
				) : (
					<p className='text-body text-muted-foreground'>Start the service to open a terminal.</p>
				)
			) : null}

			{tab === 'tasks' ? <ScheduledTasks serviceId={serviceId} /> : null}

			{tab === 'settings' && service.data ? (
				<ServiceSettings projectId={projectId} service={service.data} />
			) : null}
		</>
	)
}

/**
 * What you open a database for: the credentials to reach it, and the image it
 * runs. The credentials are read back out of the service's own environment and
 * the image off the service itself, so both are what the container will
 * actually start with rather than what the catalogue currently defaults to.
 */
function DatabasePanels({ serviceId }: { serviceId: string }) {
	const [revealed, setRevealed] = useState(false)
	const connection = useQuery({
		queryKey: ['service', serviceId, 'database'],
		queryFn: () => api.serviceDatabase(serviceId),
	})

	const { data } = connection
	if (!data) return null

	const mask = (value: string) => (revealed ? value : '•'.repeat(12))
	const upgrades = data.versions.filter(tag => !data.image.endsWith(`:${tag}`))

	return (
		<div className='mb-4 grid gap-4 lg:grid-cols-2'>
			<Section title='Connection'>
				<Facts>
					<Fact label='Host' value={data.host} />
					<Fact label='Port' value={data.port} />
					{data.database ? <Fact label='Database' value={data.database} /> : null}
					{data.user ? <Fact label='User' value={data.user} /> : null}
					<Fact label='Password' value={mask(data.password)} />
					<Fact label='URL' value={revealed ? data.url : data.url.replace(data.password, '•••')} />
				</Facts>
				<div className='mt-2 flex items-center gap-3'>
					<Button variant='ghost' onClick={() => setRevealed(value => !value)}>
						{revealed ? 'Hide' : 'Reveal'}
					</Button>
					<p className='text-label text-muted-foreground'>
						Reachable under this hostname from every other service in this project.
					</p>
				</div>
			</Section>

			<Section title='Engine'>
				<Facts>
					<Fact label='Engine' value={data.engine} />
					<Fact label='Image' value={data.image} />
					<Fact label='Volume' value={data.data_volume} />
					<Fact label='Other tags' value={upgrades.slice(0, 4).join(', ') || '-'} />
				</Facts>
				<p className='mt-2 text-label text-muted-foreground'>
					Change the image in Settings, then Deploy this service to move versions.
				</p>
			</Section>
		</div>
	)
}

/**
 * Managed services get their own .env file, so their credentials never collide
 * with a sibling running the same engine.
 */
function ServiceEnvironment({ serviceId }: { serviceId: string }) {
	const queryClient = useQueryClient()
	const [text, setText] = useState('')

	const environment = useQuery({
		queryKey: ['service', serviceId, 'environment'],
		queryFn: () => api.serviceVariables(serviceId),
	})

	useEffect(() => {
		if (environment.data) setText(toDotenv(environment.data))
	}, [environment.data])

	const save = useMutation({
		mutationFn: () => api.saveServiceVariables(serviceId, fromDotenv(text, environment.data ?? [])),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', serviceId, 'environment'] }),
	})

	return (
		<Section
			title='Environment variables'
			description='written to this service’s own .env with 0600 permissions'
			onSave={() => save.mutate()}
			actions={
				<Button variant='primary' onClick={() => save.mutate()} disabled={save.isPending}>
					{save.isPending ? 'Saving…' : 'Save'}
				</Button>
			}
		>
			<ErrorText error={save.error} />
			<textarea
				rows={18}
				value={text}
				placeholder='KEY=value'
				onChange={event => setText(event.target.value)}
				className='font-mono text-body'
				spellCheck={false}
			/>
			<p className='mt-1 text-label text-muted-foreground'>One KEY=value per line. Redeploy to apply.</p>
		</Section>
	)
}

type TaskForm = { id: string | null; name: string; schedule: string; command: string }

const emptyTask: TaskForm = { id: null, name: '', schedule: '0 3 * * *', command: '' }

type TaskActions = {
	select: (id: string) => void
	edit: (task: ScheduledTask) => void
	run: (id: string) => void
	toggle: (task: ScheduledTask) => void
	remove: (id: string) => void
	runningId: string | null
	confirming: string | null
	setConfirming: (id: string | null) => void
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
}: TaskActions): Columns<ScheduledTask> {
	const cell = columnsFor<ScheduledTask>()
	return [
		cell.accessor(task => task.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<>
					{row.original.name}
					{row.original.enabled ? null : <span className='ml-2 text-label text-muted-foreground'>off</span>}
				</>
			),
		}),
		cell.accessor(task => task.schedule, { id: 'schedule', header: 'Schedule', meta: { mono: true } }),
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
 * Cron jobs that exec inside this service's container, with the same reach as
 * the terminal tab. The manager ticks once a minute against UTC and skips a
 * task whose previous run has not finished.
 */
function ScheduledTasks({ serviceId }: { serviceId: string }) {
	const queryClient = useQueryClient()
	const [form, setForm] = useState<TaskForm>(emptyTask)
	const [selected, setSelected] = useState<string | null>(null)
	const [confirming, setConfirming] = useState<string | null>(null)

	const tasks = useQuery({
		queryKey: ['service', serviceId, 'tasks'],
		queryFn: () => api.serviceTasks(serviceId),
	})
	const invalidate = () => queryClient.invalidateQueries({ queryKey: ['service', serviceId, 'tasks'] })
	const selectedTask = tasks.data?.find(task => task.id === selected)

	const save = useMutation({
		mutationFn: ({ id, ...body }: TaskForm) => (id ? api.updateTask(id, body) : api.createTask(serviceId, body)),
		onSuccess: async () => {
			setForm(emptyTask)
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
			if (form.id === id) setForm(emptyTask)
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
				edit: task => setForm({ id: task.id, name: task.name, schedule: task.schedule, command: task.command }),
				run: runTask,
				toggle: toggleTask,
				remove: removeTask,
				runningId,
				confirming,
				setConfirming,
			}),
		[runTask, toggleTask, removeTask, runningId, confirming],
	)

	return (
		<>
			<Section title='Scheduled tasks' description='run inside this service’s container, on UTC'>
				<DataTable
					data={tasks.data ?? []}
					columns={columns}
					loading={tasks.isLoading}
					getRowId={task => task.id}
					empty='No scheduled tasks.'
				/>

				<form
					className='mt-3 flex flex-wrap items-end gap-2'
					onSubmit={event => {
						event.preventDefault()
						save.mutate(form)
					}}
				>
					<div className='w-48'>
						<Field label='Name'>
							<input
								required
								value={form.name}
								onChange={event => setForm({ ...form, name: event.target.value })}
								placeholder='nightly backup'
							/>
						</Field>
					</div>
					<div className='w-40'>
						<Field label='Schedule' hint='cron, or @daily'>
							<input
								required
								value={form.schedule}
								onChange={event => setForm({ ...form, schedule: event.target.value })}
								className='font-mono'
							/>
						</Field>
					</div>
					<div className='min-w-64 flex-1'>
						<Field label='Command'>
							<input
								required
								value={form.command}
								onChange={event => setForm({ ...form, command: event.target.value })}
								placeholder='php artisan schedule:run'
								className='font-mono'
								spellCheck={false}
							/>
						</Field>
					</div>
					<div className='flex gap-2 pb-3'>
						<Button type='submit' disabled={save.isPending}>
							{form.id ? 'Save task' : 'Add task'}
						</Button>
						{form.id ? (
							<Button variant='ghost' onClick={() => setForm(emptyTask)}>
								Cancel
							</Button>
						) : null}
					</div>
				</form>
				<ErrorText error={save.error ?? run.error ?? toggle.error ?? remove.error} />
			</Section>

			{selectedTask ? <TaskRuns task={selectedTask} onClose={() => setSelected(null)} /> : null}
		</>
	)
}

/** Recent executions of one task, newest first, with the output it produced. */
function TaskRuns({ task, onClose }: { task: ScheduledTask; onClose: () => void }) {
	const [openRun, setOpenRun] = useState<string | null>(null)
	const runs = useQuery({ queryKey: ['task', task.id, 'runs'], queryFn: () => api.taskRuns(task.id) })

	const shown = runs.data?.find(candidate => candidate.id === openRun) ?? runs.data?.[0]

	return (
		<Section
			title={`Runs of ${task.name}`}
			description='newest 20'
			actions={
				<Button variant='ghost' onClick={onClose}>
					close
				</Button>
			}
		>
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
		</Section>
	)
}

function ServiceSettings({ projectId, service }: { projectId: string; service: Service }) {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [image, setImage] = useState(service.image)
	const [repositoryUrl, setRepositoryUrl] = useState(service.repository_url)
	const [branch, setBranch] = useState(service.branch)
	const [buildPath, setBuildPath] = useState(service.build_path)
	const [fragment, setFragment] = useState(service.compose_fragment)
	const [confirmDelete, setConfirmDelete] = useState(false)

	// An application arrives here as a bare name, so this page is where its
	// source gets answered. Once saved the answer sticks and the select goes
	// away: the checkout and the env file already hang off it.
	const pending = service.source_type === 'unconfigured'
	const [source, setSource] = useState<'git' | 'image'>('git')
	const showing = pending ? source : service.source_type

	const save = useMutation({
		mutationFn: () =>
			api.updateService(service.id, {
				...(pending ? { source_type: source } : {}),
				...(showing === 'git'
					? { repository_url: repositoryUrl, branch: branch || 'main', build_path: buildPath }
					: {}),
				...(showing === 'image' ? { image } : {}),
				...(showing === 'compose' ? { compose_fragment: fragment } : {}),
			}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', service.id] }),
	})

	const remove = useMutation({
		mutationFn: () => api.deleteService(service.id),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['services', projectId] })
			await navigate({ to: '/projects/$projectId', params: { projectId } })
		},
	})

	return (
		<>
			<Section
				title='Settings'
				description='applied on the next deploy'
				onSave={() => save.mutate()}
				actions={
					<Button variant='primary' onClick={() => save.mutate()} disabled={save.isPending}>
						{save.isPending ? 'Saving…' : 'Save'}
					</Button>
				}
			>
				<div className='grid gap-x-6 md:grid-cols-2'>
					{pending ? (
						<Field label='Source' hint='Set once. To change it later, delete the service and add it again.'>
							<select
								value={source}
								onChange={event => setSource(event.target.value === 'image' ? 'image' : 'git')}
							>
								<option value='git'>Git repository</option>
								<option value='image'>Docker image</option>
							</select>
						</Field>
					) : null}
					{showing === 'git' ? (
						<>
							<Field label='Repository'>
								<input value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} />
							</Field>
							<Field label='Branch'>
								<input value={branch} onChange={event => setBranch(event.target.value)} />
							</Field>
							<Field label='Build path'>
								<input value={buildPath} onChange={event => setBuildPath(event.target.value)} />
							</Field>
						</>
					) : null}
					{showing === 'image' ? (
						<Field
							label='Image'
							hint={
								service.type === 'database'
									? 'Changing the tag is how a database moves version.'
									: undefined
							}
						>
							<input value={image} onChange={event => setImage(event.target.value)} />
						</Field>
					) : null}
				</div>
				{showing === 'compose' ? (
					<Field label='Compose fragment'>
						<textarea
							rows={10}
							value={fragment}
							onChange={event => setFragment(event.target.value)}
							className='font-mono text-body'
							spellCheck={false}
						/>
					</Field>
				) : null}
				<ErrorText error={save.error} />
			</Section>

			<Section title='Delete service' description='its named volume is kept'>
				<ErrorText error={remove.error} />
				{confirmDelete ? (
					<div className='flex gap-2'>
						<Button variant='danger' onClick={() => remove.mutate()} disabled={remove.isPending}>
							{remove.isPending ? 'Deleting…' : `Delete ${service.compose_service_name}`}
						</Button>
						<Button variant='ghost' onClick={() => setConfirmDelete(false)}>
							Cancel
						</Button>
					</div>
				) : (
					<Button variant='danger' onClick={() => setConfirmDelete(true)}>
						Delete service
					</Button>
				)}
				<p className='mt-1 text-label text-muted-foreground'>
					Removes it from the compose overlay and drops its environment. The data volume stays, so recreating
					the service under the same name picks it back up.
				</p>
			</Section>
		</>
	)
}

function terminalUrl(serviceId: string): string {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
	return `${protocol}//${window.location.host}/api/services/${serviceId}/terminal`
}
