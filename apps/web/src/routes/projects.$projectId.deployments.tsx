import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, ErrorText, Refresh, Section, Status } from '../components/primitives'
import { api, type Deployment } from '../lib/api'
import { duration, shortSha, since } from '../lib/format'

function deploymentTableColumns(redeploy: (id: string) => void): Columns<Deployment> {
	const cell = columnsFor<Deployment>()
	return [
		cell.accessor(deployment => deployment.number, {
			id: 'number',
			header: '#',
			meta: { mono: true },
			cell: ({ row }) => (
				<Link
					to='/deployments/$deploymentId'
					params={{ deploymentId: row.original.id }}
					className='hover:underline'
				>
					#{row.original.number}
				</Link>
			),
		}),
		cell.accessor(deployment => deployment.status, {
			id: 'status',
			header: 'Status',
			cell: ({ row }) => <Status value={row.original.status} />,
		}),
		cell.accessor(deployment => deployment.service_name || 'all', {
			id: 'service',
			header: 'Service',
			meta: { mono: true },
		}),
		cell.accessor(deployment => deployment.branch, { id: 'branch', header: 'Branch', meta: { mono: true } }),
		cell.accessor(deployment => deployment.commit_sha, {
			id: 'commit',
			header: 'Commit',
			meta: { mono: true },
			cell: ({ row }) => shortSha(row.original.commit_sha),
		}),
		cell.accessor(deployment => deployment.trigger, { id: 'trigger', header: 'Trigger' }),
		cell.accessor(deployment => deployment.started_at ?? '', {
			id: 'duration',
			header: 'Duration',
			meta: { mono: true },
			cell: ({ row }) => duration(row.original.started_at, row.original.finished_at),
		}),
		cell.accessor(deployment => deployment.created_at, {
			id: 'when',
			header: 'When',
			cell: ({ row }) => since(row.original.created_at),
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row: { original } }) =>
				original.commit_sha && original.status === 'success' ? (
					<Button variant='ghost' onClick={() => redeploy(original.id)} title='Redeploy this commit'>
						redeploy this
					</Button>
				) : null,
		}),
	]
}

export const Route = createFileRoute('/projects/$projectId/deployments')({ component: ProjectDeployments })

function ProjectDeployments() {
	const { projectId } = Route.useParams()
	const navigate = useNavigate()
	const queryClient = useQueryClient()

	const deployments = useQuery({
		queryKey: ['deployments', projectId],
		queryFn: () => api.deployments(projectId),
		refetchInterval: 5000,
	})

	const rollback = useMutation({
		mutationFn: (id: string) => api.rollback(id),
		onSuccess: async deployment => {
			await queryClient.invalidateQueries({ queryKey: ['deployments', projectId] })
			await navigate({ to: '/deployments/$deploymentId', params: { deploymentId: deployment.id } })
		},
	})

	const data = deployments.data ?? []
	const { mutate: redeploy } = rollback
	const columns = useMemo(() => deploymentTableColumns(redeploy), [redeploy])

	return (
		<Section
			title='Deployment history'
			description={`${data.length} total`}
			actions={<Refresh onClick={() => deployments.refetch()} busy={deployments.isFetching} />}
		>
			<ErrorText error={rollback.error} />
			<DataTable
				data={data}
				columns={columns}
				loading={deployments.isLoading}
				getRowId={deployment => deployment.id}
				empty='No deployments yet.'
			/>
		</Section>
	)
}
