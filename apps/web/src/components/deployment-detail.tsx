import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type Line, LogViewer } from '../components/log-viewer'
import { api, type Deployment, type DeploymentStep } from '../lib/api'
import { duration } from '../lib/format'
import { useEventSource } from '../lib/sse'
import { Button, ErrorText, Status } from './primitives'

type LogLine = { step: string; text: string; at: string }

/**
 * One deployment's pipeline and its log, streamed while it runs. Rendered
 * inside the row that was opened on the project's deployments tab.
 */
export function DeploymentDetail({ deploymentId }: { deploymentId: string }) {
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
				void queryClient.invalidateQueries({ queryKey: ['deployments'] })
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
	const isRunning = deployment?.status === 'running' || deployment?.status === 'queued'

	return (
		<div className='flex flex-col gap-3 bg-background/40 px-3 py-3'>
			<ErrorText error={cancel.error} />
			{deployment?.error ? <p className='text-body text-destructive'>{deployment.error}</p> : null}

			<div className='flex flex-wrap items-center gap-x-6 gap-y-2'>
				{steps.length === 0 ? (
					<span className='text-body text-muted-foreground'>Waiting for the runner…</span>
				) : (
					steps.map(step => (
						<span key={step.id} className='flex items-center gap-2'>
							<span className='font-mono text-body'>{step.name}</span>
							<Status value={step.status} />
							<span className='font-mono text-label text-muted-foreground'>
								{duration(step.started_at, step.finished_at)}
							</span>
						</span>
					))
				)}
				{isRunning ? (
					<span className='ml-auto'>
						<Button variant='danger' onClick={() => cancel.mutate()}>
							Cancel
						</Button>
					</span>
				) : null}
			</div>

			<LogViewer lines={logLines} className='h-80' />
		</div>
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
