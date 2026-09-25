import { useMemo, useRef, useState } from 'react'
import { IconX } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type Line, LogViewer } from '../components/log-viewer'
import { api, type Deployment, type DeploymentStep } from '../lib/api'
import { duration } from '../lib/format'
import { useEventSource } from '../lib/sse'
import { Button, ErrorText, Timeline } from './primitives'

type LogLine = { step: string; text: string; at: string }

const MAX_LINES = 5000

function recordedLines(steps: DeploymentStep[]): Line[] {
	return steps.flatMap(step =>
		(step.output ?? '')
			.split('\n')
			.filter(Boolean)
			.map(text => ({ stream: 'stdout', text })),
	)
}

/**
 * One deployment's pipeline and its log, streamed while it runs. Rendered in
 * the dialog a deployments table opens for a row.
 */
export function DeploymentDetail({ deploymentId }: { deploymentId: string }) {
	const queryClient = useQueryClient()
	const [deployment, setDeployment] = useState<Deployment | null>(null)
	const [steps, setSteps] = useState<DeploymentStep[]>([])
	const [lines, setLines] = useState<LogLine[]>([])
	const [live, setLive] = useState(true)
	// What the steps had recorded when the stream attached. The live stream only
	// carries what arrives after, so without this the first streamed line hides
	// every step that finished before the page was opened.
	const backlog = useRef<Line[]>([])

	useEventSource(
		`/api/deployments/${deploymentId}/events`,
		{
			snapshot: data => {
				const payload = data as { deployment: Deployment; steps: DeploymentStep[] }
				setDeployment(payload.deployment)
				setSteps(payload.steps)
				backlog.current = recordedLines(payload.steps)
				// A reconnect re-sends the snapshot, and the steps in it already
				// carry every line streamed so far.
				setLines([])
			},
			log: data =>
				setLines(current => {
					const next = [...current, data as LogLine]
					return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
				}),
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
				? [...backlog.current, ...lines.map(line => ({ stream: 'stdout', text: `${line.at} ${line.text}` }))]
				: recordedLines(steps),
		[lines, steps],
	)

	const cancel = useMutation({ mutationFn: () => api.cancelDeployment(deploymentId) })
	const isRunning = deployment?.status === 'running' || deployment?.status === 'queued'

	return (
		<div className='flex flex-col gap-3'>
			<ErrorText error={cancel.error} />
			<ErrorText error={deployment?.error} />

			{/* On a phone the log needs the full width, so the pipeline sits above it. */}
			<div className='flex flex-col gap-4 sm:flex-row'>
				<div className='flex shrink-0 flex-col gap-3 sm:w-52'>
					{steps.length === 0 ? (
						<span className='text-body text-muted-foreground'>Waiting for the runner…</span>
					) : (
						<Timeline
							steps={steps.map(step => ({
								id: step.id,
								name: step.name,
								status: step.status,
								detail: duration(step.started_at, step.finished_at),
							}))}
						/>
					)}
					{isRunning ? (
						<Button variant='danger' onClick={() => cancel.mutate()}>
							<IconX />
							Cancel
						</Button>
					) : null}
				</div>

				<LogViewer lines={logLines} build className='h-[60dvh] min-w-0 flex-1' />
			</div>
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
