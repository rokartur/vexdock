import { useMemo, useState } from 'react'
import { IconBox, IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { Sparkline } from '@/components/ui/sparkline'
import { type Columns, DataTable, RowTitle, columnsFor } from '../components/data-table'
import { LogViewer } from '../components/log-viewer'
import {
	Confirm,
	EmptyState,
	ErrorText,
	IconButton,
	Meter,
	Page,
	Refresh,
	RelativeTime,
	Section,
	Status,
} from '../components/primitives'
import { api, type ContainerAction, type ContainerSummary } from '../lib/api'
import { composeProjects } from '../lib/environment'
import { bytes, containerName, percent } from '../lib/format'
import { containersQuery, preload, projectsQuery } from '../lib/queries'

/** The sampler records once a minute, so nothing is gained by asking faster. */
const USAGE_TICK_MS = 60_000

/**
 * Whether the usage columns have anything to say. A stopped container's last
 * recorded minute is not its usage now, and one younger than the sampler's tick
 * has no reading at all, which is not the same number as zero.
 */
function sampled(container: ContainerSummary) {
	return container.state === 'running' && (container.cpu_series?.length ?? 0) > 0
}

type ContainerActions = {
	act: (id: string, action: ContainerAction) => void
	/** The action in flight. One at a time: a second click anywhere waits for the first to land. */
	pending: { id: string; action: ContainerAction } | undefined
	projectLabel: (composeProject: string) => string
}

function containerTableColumns({ act, pending, projectLabel }: ContainerActions): Columns<ContainerSummary> {
	const cell = columnsFor<ContainerSummary>()
	return [
		cell.accessor(containerName, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2'>
					<IconBox stroke={1.75} className='size-4 shrink-0 text-muted' />
					<RowTitle className='max-w-32 truncate font-mono text-xs'>{containerName(row.original)}</RowTitle>
					{row.original.managed ? null : <Badge>External</Badge>}
				</span>
			),
		}),
		cell.accessor(container => container.state, {
			id: 'state',
			header: 'State',
			cell: ({ row }) => <Status value={row.original.state} />,
		}),
		cell.accessor(container => container.image, {
			id: 'image',
			header: 'Image',
			meta: { mono: true },
			cell: ({ getValue }) => (
				<span title={getValue()} className='block max-w-28 truncate'>
					{getValue()}
				</span>
			),
		}),
		cell.accessor(container => projectLabel(container.project) || '-', {
			id: 'project',
			header: 'Project',
		}),
		cell.accessor(container => (sampled(container) ? container.cpu_percent : -1), {
			id: 'cpu',
			header: 'CPU',
			// The reading and its last 30 minutes share one column; a meter beside the sparkline drew the same number twice.
			cell: ({ row: { original } }) =>
				sampled(original) ? (
					<div className='flex items-center gap-2'>
						<span className='w-10 text-right font-mono text-xs tabular-nums'>
							{percent(original.cpu_percent)}
						</span>
						<div title='Last 30 minutes' className='w-14'>
							<Sparkline
								data={original.cpu_series ?? []}
								label={`${containerName(original)} CPU, last 30 minutes`}
								width={56}
								height={16}
								area={false}
								interactive={false}
								caption={false}
								max={100}
							/>
						</div>
					</div>
				) : (
					'-'
				),
		}),
		cell.accessor(container => (sampled(container) ? container.memory_usage : -1), {
			id: 'memory',
			header: 'Memory',
			cell: ({ row: { original } }) =>
				sampled(original) ? (
					<Meter
						label={
							original.memory_limit > 0
								? `${bytes(original.memory_usage)} / ${bytes(original.memory_limit)}`
								: bytes(original.memory_usage)
						}
						value={original.memory_usage}
						max={original.memory_limit}
					/>
				) : (
					'-'
				),
		}),
		cell.accessor(container => container.created, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => <RelativeTime at={row.original.created} />,
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => {
				const container = row.original
				const name = containerName(container)
				// Docker refuses Start and a plain remove on a paused container but stops it, so paused reads as running here.
				const running = ['running', 'restarting', 'paused'].includes(container.state)
				const busy = pending !== undefined
				const loading = (action: ContainerAction) => pending?.id === container.id && pending.action === action
				return (
					<span className='flex justify-end gap-0.5'>
						<IconButton
							icon={IconRefresh}
							label={`Restart ${name}`}
							loading={loading('restart')}
							disabled={busy}
							onClick={() => act(container.id, 'restart')}
						/>
						{/* This list holds the panel's own manager and Nginx too: a restart comes back on its own, a stopped manager cannot start itself. */}
						{running ? (
							<Confirm
								title={`Stop ${name}?`}
								description='Anything it serves is offline until it starts again.'
								action='Stop container'
								icon={IconPlayerStop}
								onConfirm={() => act(container.id, 'stop')}
							>
								<IconButton
									icon={IconPlayerStop}
									label={`Stop ${name}`}
									loading={loading('stop')}
									disabled={busy}
								/>
							</Confirm>
						) : (
							<IconButton
								icon={IconPlayerPlay}
								label={`Start ${name}`}
								loading={loading('start')}
								disabled={busy}
								onClick={() => act(container.id, 'start')}
							/>
						)}
						{/* A running container is stopped first: no force flag, no service killed by a mis-click. */}
						{running ? null : (
							<Confirm
								title={`Delete ${name}?`}
								description='The container is removed. Its image and volumes stay.'
								action='Delete container'
								onConfirm={() => act(container.id, 'remove')}
							>
								<IconButton
									icon={IconTrash}
									label={`Delete ${name}`}
									loading={loading('remove')}
									disabled={busy}
								/>
							</Confirm>
						)}
					</span>
				)
			},
		}),
	]
}

export const Route = createFileRoute('/docker/containers')({
	validateSearch: (search: Record<string, unknown>) => ({
		q: typeof search.q === 'string' ? search.q : undefined,
	}),
	loader: ({ context: { queryClient } }) =>
		Promise.all([preload(queryClient, containersQuery), preload(queryClient, projectsQuery)]),
	component: ContainersPage,
})

/**
 * Every container on the host, managed or not. Foreign stacks are visible but
 * clearly marked: the platform does not take them over.
 */
function ContainersPage() {
	const queryClient = useQueryClient()
	const { q } = Route.useSearch()
	const [logsFor, setLogsFor] = useState<string | null>(null)

	const [paused, setPaused] = useState(false)
	const containers = useQuery({
		...containersQuery,
		refetchInterval: paused ? false : USAGE_TICK_MS,
		refetchOnWindowFocus: !paused,
	})

	const projects = useQuery(projectsQuery)

	const act = useMutation({
		mutationFn: ({ id, action }: { id: string; action: ContainerAction }) => api.containerAction(id, action),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['containers'] }),
	})

	const data = containers.data ?? []
	const { mutate: runAction } = act
	const pending = act.isPending ? act.variables : undefined
	const columns = useMemo(() => {
		const byName = composeProjects(projects.data ?? [])
		return containerTableColumns({
			act: (id, action) => runAction({ id, action }),
			pending,
			projectLabel: composeProject => byName.get(composeProject)?.label ?? composeProject,
		})
	}, [runAction, pending, projects.data])

	return (
		<Page fill>
			<Section
				title='All containers'
				fill
				total={containers.data?.length}
				actions={
					<>
						{/* WCAG 2.2.2: the usage columns refresh every minute beside the rest of the row. */}
						<IconButton
							icon={paused ? IconPlayerPlay : IconPlayerPause}
							label={paused ? 'Resume usage updates' : 'Pause usage updates'}
							onClick={() => setPaused(!paused)}
						/>
						<Refresh onClick={() => containers.refetch()} />
					</>
				}
			>
				<ErrorText error={act.error} />
				<ErrorText error={projects.error} />
				<DataTable
					// Arriving from another page with a different term has to re-seed the filter box.
					key={q}
					initialFilter={q}
					data={data}
					columns={columns}
					loading={containers.isLoading}
					error={containers.error}
					getRowId={container => container.id}
					filter='Filter containers'
					empty={<EmptyState title='No containers' description='Deploy a service to start one.' />}
					detail={{
						openId: logsFor,
						onOpenChange: setLogsFor,
						title: containerName,
						description: container => `Logs · ${container.image}`,
						render: container => (
							<LogViewer
								key={container.id}
								url={`/api/docker/containers/${container.id}/logs`}
								inset
								className='h-[65dvh]'
							/>
						),
					}}
				/>
			</Section>
		</Page>
	)
}
