import { useMemo, useState } from 'react'
import { IconBox, IconFileText, IconPlayerPlay, IconPlayerStop, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { LogViewer } from '../components/log-viewer'
import { Confirm, ErrorText, IconButton, Page, Refresh, Section, Status } from '../components/primitives'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '../components/ui/drawer'
import { api, type ContainerAction, type ContainerSummary } from '../lib/api'
import { since } from '../lib/format'

function containerName(container: ContainerSummary) {
	return container.names[0]?.replace(/^\//u, '') ?? container.id.slice(0, 12)
}

type ContainerActions = {
	showLogs: (id: string) => void
	act: (id: string, action: ContainerAction) => void
}

function containerTableColumns({ showLogs, act }: ContainerActions): Columns<ContainerSummary> {
	const cell = columnsFor<ContainerSummary>()
	return [
		cell.accessor(containerName, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2'>
					<IconBox className='size-4 text-muted-foreground' />
					<span className='font-mono text-label'>{containerName(row.original)}</span>
					{row.original.managed ? null : <Badge variant='outline'>external</Badge>}
				</span>
			),
		}),
		cell.accessor(container => container.state, {
			id: 'state',
			header: 'State',
			cell: ({ row }) => <Status value={row.original.state} />,
		}),
		cell.accessor(container => container.image, { id: 'image', header: 'Image', meta: { mono: true } }),
		cell.accessor(container => container.project || '-', {
			id: 'project',
			header: 'Project',
			meta: { mono: true },
		}),
		cell.accessor(container => container.created, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => <span className='text-muted-foreground'>{since(row.original.created)}</span>,
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => {
				const container = row.original
				const running = container.state === 'running'
				return (
					<span className='flex justify-end gap-0.5'>
						<IconButton icon={IconFileText} label='Logs' onClick={() => showLogs(container.id)} />
						<IconButton icon={IconRefresh} label='Restart' onClick={() => act(container.id, 'restart')} />
						<IconButton
							icon={running ? IconPlayerStop : IconPlayerPlay}
							label={running ? 'Stop' : 'Start'}
							onClick={() => act(container.id, running ? 'stop' : 'start')}
						/>
						{/* A running container is stopped first: no force flag, no service killed by a mis-click. */}
						{running ? null : (
							<Confirm
								title={`Delete ${containerName(container)}?`}
								description='The container is removed. Its image and volumes stay.'
								onConfirm={() => act(container.id, 'remove')}
							>
								<IconButton icon={IconTrash} label='Delete' />
							</Confirm>
						)}
					</span>
				)
			},
		}),
	]
}

export const Route = createFileRoute('/docker/containers')({ component: ContainersPage })

/**
 * Every container on the host, managed or not. Foreign stacks are visible but
 * clearly marked: the platform does not take them over.
 */
function ContainersPage() {
	const queryClient = useQueryClient()
	const [logsFor, setLogsFor] = useState<string | null>(null)

	const containers = useQuery({ queryKey: ['containers'], queryFn: api.containers })

	const act = useMutation({
		mutationFn: ({ id, action }: { id: string; action: ContainerAction }) => api.containerAction(id, action),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['containers'] }),
	})

	const data = containers.data ?? []
	const { mutate: runAction } = act
	const columns = useMemo(
		() => containerTableColumns({ showLogs: setLogsFor, act: (id, action) => runAction({ id, action }) }),
		[runAction],
	)
	const running = data.filter(container => container.state === 'running').length

	return (
		<Page>
			<Section
				title='All containers'
				description={`${data.length} total · ${running} running`}
				actions={<Refresh onClick={() => containers.refetch()} busy={containers.isFetching} />}
			>
				<ErrorText error={act.error} />
				<DataTable
					data={data}
					columns={columns}
					loading={containers.isLoading}
					getRowId={container => container.id}
					filter='Filter containers'
					empty='No containers'
				/>
			</Section>

			<Drawer open={logsFor !== null} onOpenChange={open => open || setLogsFor(null)}>
				<DrawerContent className='[--drawer-height:70dvh]'>
					<DrawerHeader className='pb-2'>
						<DrawerTitle className='text-title'>Logs</DrawerTitle>
					</DrawerHeader>
					<div className='min-h-0 flex-1 px-4 pb-4'>
						{logsFor ? <LogViewer key={logsFor} url={`/api/docker/containers/${logsFor}/logs`} /> : null}
					</div>
				</DrawerContent>
			</Drawer>
		</Page>
	)
}
