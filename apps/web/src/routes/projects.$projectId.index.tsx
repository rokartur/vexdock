import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, Refresh, Section, Status } from '../components/primitives'
import { api, type Service } from '../lib/api'
import { since } from '../lib/format'

export const Route = createFileRoute('/projects/$projectId/')({ component: ProjectServices })

type ServiceAction = 'start' | 'stop' | 'restart'

function serviceTableColumns(projectId: string, act: (id: string, action: ServiceAction) => void): Columns<Service> {
	const cell = columnsFor<Service>()
	return [
		cell.accessor(service => service.compose_service_name, {
			id: 'service',
			header: 'Service',
			cell: ({ row }) => (
				<Link
					to='/projects/$projectId/services/$serviceId'
					params={{ projectId, serviceId: row.original.id }}
					className='hover:underline'
				>
					{row.original.compose_service_name}
				</Link>
			),
		}),
		cell.accessor(service => service.state || 'stopped', {
			id: 'state',
			header: 'State',
			cell: ({ row }) => <Status value={row.original.state || 'stopped'} />,
		}),
		cell.accessor(service => service.health ?? '', {
			id: 'health',
			header: 'Health',
			cell: ({ row }) =>
				row.original.health ? (
					<Status value={row.original.health} />
				) : (
					<span className='text-muted-foreground'>-</span>
				),
		}),
		cell.accessor(service => service.image || '-', { id: 'image', header: 'Image', meta: { mono: true } }),
		cell.accessor(service => service.restart_count, { id: 'restarts', header: 'Restarts', meta: { mono: true } }),
		cell.accessor(service => service.created_unix ?? 0, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => (row.original.created_unix ? since(row.original.created_unix) : '-'),
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<span className='flex justify-end gap-1.5'>
					<Button variant='ghost' onClick={() => act(row.original.id, 'start')}>
						start
					</Button>
					<Button variant='ghost' onClick={() => act(row.original.id, 'restart')}>
						restart
					</Button>
					<Button variant='ghost' onClick={() => act(row.original.id, 'stop')}>
						stop
					</Button>
				</span>
			),
		}),
	]
}

function ProjectServices() {
	const { projectId } = Route.useParams()
	const queryClient = useQueryClient()

	const services = useQuery({
		queryKey: ['services', projectId],
		queryFn: () => api.services(projectId),
		refetchInterval: 5000,
	})

	const act = useMutation({
		mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) =>
			api.serviceAction(id, action),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['services', projectId] }),
	})

	const data = services.data ?? []
	const { mutate: runAction } = act
	const columns = useMemo(
		() => serviceTableColumns(projectId, (id, action) => runAction({ id, action })),
		[projectId, runAction],
	)

	return (
		<Section
			title='Services'
			description={`${data.length} defined in compose`}
			actions={<Refresh onClick={() => services.refetch()} busy={services.isFetching} />}
		>
			<DataTable
				data={data}
				columns={columns}
				loading={services.isLoading}
				getRowId={service => service.id}
				empty='No services yet. Deploy the project to create them from its compose file.'
			/>
		</Section>
	)
}
