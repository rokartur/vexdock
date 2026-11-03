import {
	IconAlertTriangle,
	IconCheck,
	IconClock,
	IconGitBranch,
	IconLoader2,
	IconRocket,
	IconX,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { api, type Deployment, type DeploymentStatus, type Service } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { duration, shortSha } from '../lib/format'
import { deploymentsQuery } from '../lib/queries'
import { DeploymentDetail } from './deployment-detail'
import { DetailDialog, EmptyState, ErrorText, IconButton, Refresh, RelativeTime, Section, Status } from './primitives'

/**
 * Which deployment is open lives in the URL, so anything that starts a deploy
 * can link straight at its log. The route that renders the panel validates it.
 */
export const deploymentSearch = {
	validateSearch: (search: Record<string, unknown>): { deployment?: string } =>
		typeof search.deployment === 'string' ? { deployment: search.deployment } : {},
}

export function DeploymentsPanel({ projectId, service }: { projectId: string; service: Service }) {
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

	const deployments = useQuery(deploymentsQuery(projectId, environmentId))

	const rollback = useMutation({
		mutationFn: api.rollback,
		onSuccess: async deployment => {
			await queryClient.invalidateQueries({ queryKey: ['deployments', projectId] })
			open(deployment.id)
		},
	})

	const data = (deployments.data ?? []).filter(deployment => deployment.service_name === service.compose_service_name)
	const opened = data.find(deployment => deployment.id === openId)

	return (
		<Section
			title='Deployment history'
			total={data.length}
			actions={<Refresh onClick={() => deployments.refetch()} busy={deployments.isFetching} />}
		>
			<ErrorText error={rollback.error ?? deployments.error} />
			<div className='rounded-surface border bg-surface py-1.5'>
				{data.length === 0 ? (
					deployments.isLoading ? (
						<EmptyState title='Loading deployments' />
					) : (
						<EmptyState scene='inbox' title='No deployments yet' />
					)
				) : (
					groupByDay(data).map(([day, items]) => (
						<section key={day} aria-label={day}>
							<h3 className='m-0 px-4 pt-3 pb-1 text-xs font-medium text-secondary'>{day}</h3>
							<ol className='relative isolate m-0 list-none px-2.5'>
								{items.map(deployment => (
									<FeedItem
										key={deployment.id}
										deployment={deployment}
										onOpen={() => open(deployment.id)}
										onRedeploy={() => rollback.mutate(deployment.id)}
									/>
								))}
							</ol>
						</section>
					))
				)}
			</div>
			<DetailDialog
				open={opened !== undefined}
				onOpenChange={next => (next ? null : open(null))}
				title={opened ? `Deployment #${opened.number}` : ''}
			>
				{opened ? <DeploymentDetail deploymentId={opened.id} /> : null}
			</DetailDialog>
		</Section>
	)
}

const STATUS_ICONS: Record<DeploymentStatus, TablerIcon> = {
	queued: IconClock,
	running: IconLoader2,
	success: IconCheck,
	failed: IconX,
	cancelled: IconAlertTriangle,
}

function FeedItem({
	deployment,
	onOpen,
	onRedeploy,
}: {
	deployment: Deployment
	onOpen: () => void
	onRedeploy: () => void
}) {
	const StatusIcon = STATUS_ICONS[deployment.status]
	const tone = deployment.status === 'success' ? 'success' : deployment.status === 'failed' ? 'danger' : undefined
	return (
		<li className="group/item relative grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-[12px] px-2.5 py-2 transition-colors after:absolute after:top-[46px] after:-bottom-1.5 after:left-[26px] after:-z-1 after:w-px after:bg-border-subtle after:content-[''] last:after:hidden pointer-fine:has-[>button:hover]:bg-surface-muted/70">
			<span className='relative grid size-8 place-items-center rounded-full bg-surface-muted text-secondary shadow-[0_0_0_1px_var(--border)]'>
				<IconRocket stroke={1.75} className='size-4' />
				<span
					aria-hidden
					data-tone={tone}
					className='absolute -right-1 -bottom-[3px] grid size-[17px] place-items-center rounded-full bg-surface-raised text-secondary shadow-[0_0_0_2px_var(--surface),inset_0_0_0_1px_var(--border)] data-[tone=danger]:text-danger data-[tone=success]:text-success'
				>
					<StatusIcon className='size-2.5' stroke={2.5} />
				</span>
			</span>
			<button type='button' onClick={onOpen} className='grid min-w-0 gap-0.5 text-left'>
				<span className='text-sm leading-[1.45] text-secondary'>
					<strong className='font-medium text-foreground'>#{deployment.number}</strong> {deployment.trigger}
					{deployment.created_by ? ` by ${deployment.created_by}` : ''}
				</span>
				<span className='flex min-w-0 items-center gap-1.5 text-xs text-muted'>
					<Status dot value={deployment.status} />
					{deployment.branch ? (
						<span className='inline-flex min-w-0 items-center gap-1 font-mono'>
							<IconGitBranch stroke={1.75} className='size-3 flex-none' />
							<span className='truncate'>{deployment.branch}</span>
						</span>
					) : null}
					{deployment.commit_sha ? (
						<span className='font-mono'>{shortSha(deployment.commit_sha)}</span>
					) : null}
					<span aria-hidden>·</span>
					<span className='font-mono'>{duration(deployment.started_at, deployment.finished_at)}</span>
				</span>
			</button>
			<span className='inline-flex items-center gap-1 pt-0.5 text-xs whitespace-nowrap text-muted tabular-nums'>
				<RelativeTime at={deployment.created_at} />
				{deployment.commit_sha && deployment.status === 'success' ? (
					<IconButton icon={IconRocket} label='Redeploy this commit' onClick={onRedeploy} />
				) : null}
			</span>
		</li>
	)
}

/** Newest first, as the API answers, cut at local midnight. */
function groupByDay(deployments: Deployment[]) {
	const groups = new Map<string, Deployment[]>()
	for (const deployment of deployments) {
		const day = dayLabel(new Date(deployment.created_at))
		groups.set(day, [...(groups.get(day) ?? []), deployment])
	}
	return [...groups]
}

function dayLabel(date: Date) {
	const today = new Date()
	const yesterday = new Date(today)
	yesterday.setDate(today.getDate() - 1)
	if (date.toDateString() === today.toDateString()) return 'Today'
	if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
	return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}
