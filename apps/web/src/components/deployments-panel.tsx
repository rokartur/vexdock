import { useEffect, useState } from 'react'
import { IconGitBranch, IconRocket } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { api, type Deployment, type Service } from '../lib/api'
import { duration, shortSha } from '../lib/format'
import { morph } from '../lib/motion'
import { deploymentsQuery } from '../lib/queries'
import { DeploymentDetail } from './deployment-detail'
import {
	Button,
	DetailDialog,
	EmptyState,
	ErrorText,
	IconButton,
	Refresh,
	RelativeTime,
	runLook,
	Section,
	statusWord,
} from './primitives'
import { Skeleton } from './ui/skeleton'

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
	const today = useToday()

	// The dialog opens over the history in place, so the history keeps its scroll.
	const open = (id: string | null) =>
		navigate({
			to: '.',
			search: previous => ({ ...previous, deployment: id ?? undefined }),
			replace: true,
			resetScroll: false,
		})

	const deployments = useQuery(deploymentsQuery(projectId, service.environment_id, service.compose_service_name))

	const rollback = useMutation({
		mutationFn: api.rollback,
		onSuccess: async deployment => {
			await queryClient.invalidateQueries({ queryKey: ['deployments', projectId] })
			open(deployment.id)
		},
	})

	const data = deployments.data ?? []
	const opened = data.find(deployment => deployment.id === openId)

	return (
		<Section
			title='Deployment history'
			total={deployments.data ? data.length : undefined}
			actions={<Refresh onClick={() => deployments.refetch()} />}
		>
			<ErrorText error={deployments.error} />
			<ErrorText error={rollback.error} />
			{data.length === 0 && deployments.error ? null : (
				<div className='rounded-surface border bg-surface py-1.5'>
					{data.length === 0 ? (
						deployments.isLoading ? (
							<Skeleton label='Loading deployments' avatar lines={2} className='px-5 py-2.5' />
						) : (
							<EmptyState
								scene='inbox'
								title='No deployments yet'
								description='Each deploy and its log show up here.'
							>
								<Button
									render={
										<Link
											to='/projects/$projectId/services/$serviceId'
											params={{ projectId, serviceId: service.id }}
										/>
									}
								>
									<IconRocket size={16} stroke={1.75} />
									Open General
								</Button>
							</EmptyState>
						)
					) : (
						groupByDay(data, today).map(([day, items]) => (
							<section key={day}>
								<h3 className='m-0 px-4 pt-3 pb-1 text-xs font-medium text-secondary'>{day}</h3>
								<ol className='relative isolate m-0 list-none px-2.5'>
									{items.map(deployment => (
										<FeedItem
											key={deployment.id}
											deployment={deployment}
											onOpen={target =>
												morph(target, `detail-${deployment.id}`, () => open(deployment.id))
											}
											onRedeploy={() => rollback.mutate(deployment.id)}
											redeploying={rollback.isPending && rollback.variables === deployment.id}
											busy={rollback.isPending}
										/>
									))}
								</ol>
							</section>
						))
					)}
				</div>
			)}
			<DetailDialog
				open={opened !== undefined}
				onOpenChange={next => (next ? null : open(null))}
				title={opened ? `#${opened.number}` : ''}
				description={opened ? triggeredBy(opened).replace(/^./u, first => first.toUpperCase()) : undefined}
				morph={opened ? `detail-${opened.id}` : undefined}
			>
				{opened ? <DeploymentDetail deploymentId={opened.id} /> : null}
			</DetailDialog>
		</Section>
	)
}

function FeedItem({
	deployment,
	onOpen,
	onRedeploy,
	redeploying,
	busy,
}: {
	deployment: Deployment
	onOpen: (target: HTMLElement) => void
	onRedeploy: () => void
	redeploying: boolean
	/** A redeploy of any row is in flight; one at a time, so a double click cannot start two. */
	busy: boolean
}) {
	const { tone, icon: StatusIcon } = runLook(deployment.status)
	return (
		<li className="relative grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-control px-2.5 py-2 transition-[background-color] duration-110 ease-standard after:absolute after:top-[46px] after:-bottom-1.5 after:left-[26px] after:-z-1 after:w-px after:bg-border-subtle after:content-[''] last:after:hidden has-[>button:active]:bg-surface-pressed pointer-fine:has-[>button:hover:not(:active)]:bg-surface-muted/70">
			<span
				aria-hidden
				data-tone={tone}
				className='grid size-8 place-items-center rounded-full bg-surface-muted text-secondary shadow-[0_0_0_1px_var(--border)] data-[tone=danger]:text-danger data-[tone=info]:text-accent data-[tone=success]:text-success data-[tone=warning]:text-warning'
			>
				<StatusIcon stroke={1.75} className='size-4' />
			</span>
			<button
				type='button'
				onClick={event => onOpen(event.currentTarget)}
				className='grid min-w-0 gap-0.5 text-left pointer-coarse:min-h-11'
			>
				<span className='text-sm leading-[1.45] text-secondary'>
					<strong data-morph-from className='inline-block font-medium text-foreground'>
						#{deployment.number}
					</strong>{' '}
					{triggeredBy(deployment)}
				</span>
				<span className='flex min-w-0 items-center gap-1.5 text-xs text-muted'>
					<span className='text-secondary'>{statusWord(deployment.status)}</span>
					{deployment.branch || deployment.commit_sha || deployment.finished_at ? (
						<span aria-hidden>·</span>
					) : null}
					{deployment.branch ? (
						<span className='inline-flex min-w-0 items-center gap-1 font-mono'>
							<IconGitBranch stroke={1.75} className='size-3 flex-none' />
							<span className='truncate'>{deployment.branch}</span>
						</span>
					) : null}
					{deployment.commit_sha ? (
						<span className='font-mono'>{shortSha(deployment.commit_sha)}</span>
					) : null}
					{/* A running deployment has no length yet; its status already says it is going. */}
					{deployment.finished_at ? (
						<>
							{deployment.branch || deployment.commit_sha ? <span aria-hidden>·</span> : null}
							<span className='font-mono'>{duration(deployment.started_at, deployment.finished_at)}</span>
						</>
					) : null}
				</span>
			</button>
			<span className='inline-flex items-center gap-1 pt-0.5 text-xs whitespace-nowrap text-muted tabular-nums'>
				<RelativeTime at={deployment.created_at} />
				{deployment.commit_sha && deployment.status === 'success' ? (
					<IconButton
						icon={IconRocket}
						label={`Redeploy commit ${shortSha(deployment.commit_sha)}`}
						loading={redeploying}
						disabled={busy && !redeploying}
						onClick={onRedeploy}
					/>
				) : null}
			</span>
		</li>
	)
}

// The manager records a row's Redeploy as `rollback`; the feed names it after the button that started it.
function triggeredBy(deployment: Deployment) {
	const trigger = deployment.trigger === 'rollback' ? 'redeploy' : deployment.trigger
	return deployment.created_by ? `${trigger} by ${deployment.created_by}` : trigger
}

/** Today's date, which moves on at local midnight, so a tab left open does not keep calling yesterday "Today". */
function useToday() {
	const [today, setToday] = useState(() => new Date().toDateString())
	useEffect(() => {
		const midnight = new Date()
		midnight.setHours(24, 0, 0, 0)
		const timer = setTimeout(() => setToday(new Date().toDateString()), midnight.getTime() - Date.now() + 1000)
		return () => clearTimeout(timer)
	}, [today])
	return today
}

/** Newest first, as the API answers, cut at local midnight. */
function groupByDay(deployments: Deployment[], today: string) {
	const groups = new Map<string, Deployment[]>()
	for (const deployment of deployments) {
		const day = dayLabel(new Date(deployment.created_at), new Date(today))
		groups.set(day, [...(groups.get(day) ?? []), deployment])
	}
	return [...groups]
}

function dayLabel(date: Date, today: Date) {
	const yesterday = new Date(today)
	yesterday.setDate(today.getDate() - 1)
	if (date.toDateString() === today.toDateString()) return 'Today'
	if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
	const sameYear = date.getFullYear() === today.getFullYear()
	return date.toLocaleDateString([], {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: sameYear ? undefined : 'numeric',
	})
}
