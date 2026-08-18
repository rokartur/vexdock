import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Button, ErrorText, Page, Section, Status } from '../components/primitives'
import { api, type Deployment, type DeploymentStep } from '../lib/api'
import { clock, duration, shortSha } from '../lib/format'
import { useEventSource } from '../lib/sse'

export const Route = createFileRoute('/deployments/$deploymentId')({ component: DeploymentPage })

type LogLine = { step: string; text: string; at: string }

/** Live deployment pipeline: steps on the left, streamed log below. */
function DeploymentPage() {
	const { deploymentId } = Route.useParams()
	const queryClient = useQueryClient()
	const [deployment, setDeployment] = useState<Deployment | null>(null)
	const [steps, setSteps] = useState<DeploymentStep[]>([])
	const [lines, setLines] = useState<LogLine[]>([])
	const [live, setLive] = useState(true)
	const bottomRef = useRef<HTMLDivElement>(null)

	const initial = useQuery({
		queryKey: ['deployment', deploymentId],
		queryFn: () => api.deployment(deploymentId),
	})

	useEffect(() => {
		if (!initial.data) return
		setDeployment(initial.data.deployment)
		setSteps(initial.data.steps)
	}, [initial.data])

	useEventSource(
		`/api/deployments/${deploymentId}/events`,
		{
			snapshot: data => {
				const payload = data as { deployment: Deployment; steps: DeploymentStep[] }
				setDeployment(payload.deployment)
				setSteps(payload.steps)
			},
			log: data => setLines(current => [...current, data as LogLine]),
			'step.started': data => upsertStep(setSteps, data as DeploymentStep),
			'step.success': data => upsertStep(setSteps, data as DeploymentStep),
			'step.failed': data => upsertStep(setSteps, data as DeploymentStep),
			'deployment.started': data => setDeployment(data as Deployment),
			'deployment.success': data => setDeployment(data as Deployment),
			'deployment.failed': data => setDeployment(data as Deployment),
			'deployment.cancelled': data => setDeployment(data as Deployment),
			'deployment.closed': () => {
				setLive(false)
				void queryClient.invalidateQueries({ queryKey: ['projects'] })
			},
		},
		live,
	)

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: 'end' })
	}, [lines.length])

	const cancel = useMutation({ mutationFn: () => api.cancelDeployment(deploymentId) })
	const rollback = useMutation({ mutationFn: () => api.rollback(deploymentId) })

	const isRunning = deployment?.status === 'running' || deployment?.status === 'queued'

	return (
		<Page
			breadcrumb={
				deployment ? (
					<Link
						to='/projects/$projectId/deployments'
						params={{ projectId: deployment.project_id }}
						className='text-body text-muted-foreground hover:text-foreground'
					>
						deployments
					</Link>
				) : null
			}
			title={
				<span className='flex items-baseline gap-3'>
					#{deployment?.number ?? ''}
					{deployment ? <Status value={deployment.status} /> : null}
					<span className='font-mono text-body text-muted-foreground'>
						{deployment?.branch} {shortSha(deployment?.commit_sha)}
					</span>
				</span>
			}
			actions={
				<>
					{isRunning ? (
						<Button variant='danger' onClick={() => cancel.mutate()}>
							Cancel
						</Button>
					) : null}
					{!isRunning && deployment?.commit_sha ? (
						<Button onClick={() => rollback.mutate()}>Redeploy this commit</Button>
					) : null}
				</>
			}
		>
			<ErrorText error={cancel.error ?? rollback.error} />
			{deployment?.error ? <p className='mb-3 text-body text-destructive'>{deployment.error}</p> : null}

			<Section title='Pipeline'>
				<ol className='border-t border-border'>
					{steps.length === 0 ? (
						<li className='py-3 text-body text-muted-foreground'>Waiting for the runner…</li>
					) : (
						steps.map(step => (
							<li key={step.id} className='flex items-center gap-4 border-b border-border/50 py-1.5'>
								<span className='w-28 font-mono text-body'>{step.name}</span>
								<Status value={step.status} />
								<span className='font-mono text-label text-muted-foreground'>
									{duration(step.started_at, step.finished_at)}
								</span>
							</li>
						))
					)}
				</ol>
			</Section>

			<Section title='Log' description={live ? 'streaming' : 'finished'}>
				<div className='h-[50vh] overflow-auto border border-console-border bg-console p-2 font-mono text-body leading-[1.45] text-console-foreground'>
					{lines.length === 0 ? (
						<p className='text-console-muted'>
							{steps.some(step => step.output)
								? steps
										.map(step => step.output)
										.filter(Boolean)
										.join('\n')
								: 'No output yet.'}
						</p>
					) : (
						lines.map((line, index) => (
							<div key={index} className='flex gap-3'>
								<span className='shrink-0 text-console-muted'>{clock(line.at)}</span>
								<span className='break-all whitespace-pre-wrap'>{line.text}</span>
							</div>
						))
					)}
					<div ref={bottomRef} />
				</div>
			</Section>
		</Page>
	)
}

function upsertStep(setSteps: React.Dispatch<React.SetStateAction<DeploymentStep[]>>, step: DeploymentStep) {
	setSteps(current => {
		const index = current.findIndex(item => item.id === step.id)
		if (index === -1) return [...current, step]
		const next = [...current]
		next[index] = step
		return next
	})
}
