import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Line, LogViewer } from '../components/log-viewer'
import { Button, ErrorText, Page, Section, Status } from '../components/primitives'
import { api, type Deployment, type DeploymentStep } from '../lib/api'
import { duration, shortSha } from '../lib/format'
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

	// The console reads the engine's RFC3339 stamp out of the line itself. A
	// deployment opened after it finished has no stream left, only what each step
	// recorded.
	const logLines: Line[] = useMemo(
		() =>
			lines.length > 0
				? lines.map(line => ({ stream: 'stdout', text: `${line.at} ${line.text}` }))
				: steps.flatMap(step =>
						(step.output ?? '')
							.split('\n')
							.filter(Boolean)
							.map(text => ({ stream: 'stdout', text })),
					),
		[lines, steps],
	)

	const cancel = useMutation({ mutationFn: () => api.cancelDeployment(deploymentId) })
	const rollback = useMutation({ mutationFn: () => api.rollback(deploymentId) })

	const isRunning = deployment?.status === 'running' || deployment?.status === 'queued'

	return (
		<Page
			labels={{
				[deploymentId]: (
					<>
						#{deployment?.number ?? ''}
						{deployment ? <Status value={deployment.status} /> : null}
						<span className='font-mono text-body text-muted-foreground'>
							{deployment?.service_name || 'all'} · {deployment?.branch}{' '}
							{shortSha(deployment?.commit_sha)}
						</span>
					</>
				),
			}}
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
				<ol className='rounded-xl border border-border px-3'>
					{steps.length === 0 ? (
						<li className='py-3 text-body text-muted-foreground'>Waiting for the runner…</li>
					) : (
						steps.map(step => (
							<li
								key={step.id}
								className='flex items-center gap-4 border-b border-border/50 py-1.5 last:border-b-0'
							>
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
				<LogViewer lines={logLines} className='h-[50vh]' />
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
