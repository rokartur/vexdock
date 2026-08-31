import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { LogViewer } from '../components/log-viewer'
import { Button, ErrorText, Page, Refresh, Section, Status } from '../components/primitives'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '../components/ui/drawer'
import { api, type ContainerAction, type ContainerSummary } from '../lib/api'
import { since } from '../lib/format'

function containerName(container: ContainerSummary) {
	return container.names[0]?.replace(/^\//u, '') ?? container.id.slice(0, 12)
}

type ContainerActions = {
	showLogs: (id: string) => void
	act: (id: string, action: ContainerAction) => void
	pendingDelete: string | null
	setPendingDelete: (id: string | null) => void
}

function containerTableColumns({
	showLogs,
	act,
	pendingDelete,
	setPendingDelete,
}: ContainerActions): Columns<ContainerSummary> {
	const cell = columnsFor<ContainerSummary>()
	return [
		cell.accessor(containerName, {
			id: 'name',
			header: 'Name',
			meta: { mono: true },
			cell: ({ row }) => (
				<>
					{containerName(row.original)}
					{row.original.managed ? null : (
						<span className='ml-2 text-meta text-muted-foreground'>external</span>
					)}
				</>
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
			cell: ({ row }) => since(row.original.created),
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => {
				const container = row.original
				const running = container.state === 'running'
				if (pendingDelete === container.id) {
					return (
						<span className='flex justify-end gap-1.5'>
							<Button variant='danger' onClick={() => act(container.id, 'remove')}>
								confirm delete
							</Button>
							<Button variant='ghost' onClick={() => setPendingDelete(null)}>
								cancel
							</Button>
						</span>
					)
				}
				return (
					<span className='flex justify-end gap-1.5'>
						<Button variant='ghost' onClick={() => showLogs(container.id)}>
							logs
						</Button>
						<Button variant='ghost' onClick={() => act(container.id, 'restart')}>
							restart
						</Button>
						<Button variant='ghost' onClick={() => act(container.id, running ? 'stop' : 'start')}>
							{running ? 'stop' : 'start'}
						</Button>
						{/* A running container is stopped first: no force flag, no service killed by a mis-click. */}
						{running ? null : (
							<Button variant='ghost' onClick={() => setPendingDelete(container.id)}>
								delete
							</Button>
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
	const [pendingDelete, setPendingDelete] = useState<string | null>(null)

	const containers = useQuery({ queryKey: ['containers'], queryFn: api.containers })

	const act = useMutation({
		mutationFn: ({ id, action }: { id: string; action: ContainerAction }) => api.containerAction(id, action),
		onSuccess: async () => {
			setPendingDelete(null)
			await queryClient.invalidateQueries({ queryKey: ['containers'] })
		},
	})

	const data = containers.data ?? []
	const { mutate: runAction } = act
	const columns = useMemo(
		() =>
			containerTableColumns({
				showLogs: setLogsFor,
				act: (id, action) => runAction({ id, action }),
				pendingDelete,
				setPendingDelete,
			}),
		[runAction, pendingDelete],
	)

	return (
		<Page>
			<Section
				title='All containers'
				description={`${data.length} total`}
				actions={<Refresh onClick={() => containers.refetch()} busy={containers.isFetching} />}
			>
				<ErrorText error={act.error} />
				<DataTable
					data={data}
					columns={columns}
					loading={containers.isLoading}
					getRowId={container => container.id}
					empty='No containers.'
				/>
			</Section>

			<Drawer open={logsFor !== null} onOpenChange={open => open || setLogsFor(null)}>
				<DrawerContent className='[--drawer-height:70dvh]'>
					<DrawerHeader className='pb-2'>
						<DrawerTitle className='text-sm'>Logs</DrawerTitle>
					</DrawerHeader>
					<div className='min-h-0 flex-1 px-4 pb-4'>
						{logsFor ? <LogViewer key={logsFor} url={`/api/docker/containers/${logsFor}/logs`} /> : null}
					</div>
				</DrawerContent>
			</Drawer>
		</Page>
	)
}
