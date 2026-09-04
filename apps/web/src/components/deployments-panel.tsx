import { useMemo } from 'react'
import { IconGitBranch, IconGitCommit, IconRocket } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { api, type Deployment, type Service } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { duration, shortSha, since } from '../lib/format'
import { type Columns, DataTable, columnsFor } from './data-table'
import { DeploymentDetail } from './deployment-detail'
import { ErrorText, IconButton, Refresh, Section, Status } from './primitives'

/**
 * Which deployment is open lives in the URL, so anything that starts a deploy
 * can link straight at its log. Both routes that render the panel validate it.
 */
export const deploymentSearch = {
	validateSearch: (search: Record<string, unknown>): { deployment?: string } =>
		typeof search.deployment === 'string' ? { deployment: search.deployment } : {},
}

function deploymentTableColumns(redeploy: (id: string) => void): Columns<Deployment> {
	const cell = columnsFor<Deployment>()
	return [
		cell.accessor(deployment => deployment.number, {
			id: 'number',
			header: '#',
			meta: { mono: true },
			cell: ({ row }) => `#${row.original.number}`,
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
		cell.accessor(deployment => deployment.branch, {
			id: 'branch',
			header: 'Branch',
			meta: { mono: true },
			cell: ({ row }) =>
				row.original.branch ? (
					<span className='inline-flex items-center gap-1'>
						<IconGitBranch className='size-3 text-muted-foreground' />
						{row.original.branch}
					</span>
				) : null,
		}),
		cell.accessor(deployment => deployment.commit_sha, {
			id: 'commit',
			header: 'Commit',
			meta: { mono: true },
			cell: ({ row }) =>
				row.original.commit_sha ? (
					<span className='inline-flex items-center gap-1'>
						<IconGitCommit className='size-3 text-muted-foreground' />
						{shortSha(row.original.commit_sha)}
					</span>
				) : null,
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
			cell: ({ row }) => <span className='text-muted-foreground'>{since(row.original.created_at)}</span>,
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row: { original } }) =>
				original.commit_sha && original.status === 'success' ? (
					<IconButton
						icon={IconRocket}
						label='Redeploy this commit'
						onClick={event => {
							event.stopPropagation()
							redeploy(original.id)
						}}
					/>
				) : null,
		}),
	]
}

const renderDetail = (deployment: Deployment) => <DeploymentDetail deploymentId={deployment.id} />

/**
 * The environment's deployment history. Given a service it narrows to the
 * deploys that shipped it: its own, and the whole-project ones, which ship
 * every service.
 */
export function DeploymentsPanel({ projectId, service }: { projectId: string; service?: Service }) {
	const { deployment: openId = null } = useSearch({ strict: false })
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const environmentId = useEnvironmentId()

	const open = (id: string | null) => {
		void navigate({
			to: '.',
			search: previous => ({ ...previous, deployment: id ?? undefined }),
			replace: true,
		})
	}

	const deployments = useQuery({
		queryKey: ['deployments', projectId, environmentId],
		queryFn: () => api.deployments(projectId, environmentId),
	})

	const rollback = useMutation({
		mutationFn: (id: string) => api.rollback(id),
		onSuccess: async deployment => {
			await queryClient.invalidateQueries({ queryKey: ['deployments', projectId] })
			open(deployment.id)
		},
	})

	const data = (deployments.data ?? []).filter(
		deployment => !service || !deployment.service_name || deployment.service_name === service.compose_service_name,
	)
	const { mutate: redeploy } = rollback
	const columns = useMemo(
		() => deploymentTableColumns(redeploy).filter(column => !service || column.id !== 'service'),
		[redeploy, service],
	)

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
				empty='No deployments yet'
				detail={{ openId, onOpenChange: open, render: renderDetail }}
			/>
		</Section>
	)
}
