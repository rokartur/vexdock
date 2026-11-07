import { useMemo, useState } from 'react'
import { IconX } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Deployment, type DeploymentStep } from '../lib/api'
import { duration } from '../lib/format'
import { useEventSource } from '../lib/sse'
import { type Line, LogViewer, outputLines } from './log-viewer'
import { Button, Confirm, ErrorText, Status, Timeline } from './primitives'
import { Alert } from './ui/alert'

type LogLine = { step: string; text: string; at: string }

const MAX_LINES = 5000

function recordedLines(steps: DeploymentStep[]): Line[] {
	return steps.flatMap(step => outputLines(step.output ?? ''))
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
	const [backlog, setBacklog] = useState<Line[]>([])

	const stream = useEventSource(
		`/api/deployments/${deploymentId}/events`,
		{
			snapshot: data => {
				const payload = data as { deployment: Deployment; steps: DeploymentStep[] }
				setDeployment(payload.deployment)
				setSteps(payload.steps)
				setBacklog(recordedLines(payload.steps))
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
			'step.cancelled': data => upsertStep(setSteps, data as DeploymentStep),
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
				? [...backlog, ...lines.map(line => ({ stream: 'stdout', text: `${line.at} ${line.text}` }))]
				: recordedLines(steps),
		[backlog, lines, steps],
	)

	const cancel = useMutation({ mutationFn: () => api.cancelDeployment(deploymentId) })
	const isRunning = deployment?.status === 'running' || deployment?.status === 'queued'

	return (
		<div className='flex flex-col gap-3'>
			<ErrorText error={cancel.error} className='mb-0' />
			{/* A cancel also writes `cancelled` into error; the status beside the pipeline already says it. */}
			<ErrorText error={deployment?.status === 'failed' ? deployment.error : undefined} className='mb-0' />
			{live && stream === 'lost' ? (
				<Alert tone='warning' title='Lost the connection to this deployment'>
					It reconnects on its own every few seconds.
				</Alert>
			) : null}

			{/* On a phone the log needs the full width, so the pipeline sits above it. */}
			<div className='flex flex-col gap-4 sm:flex-row'>
				<div className='flex shrink-0 flex-col gap-3 sm:w-52'>
					{/* A live region, so a finish or a cancel is announced as the stream reports it. */}
					<div role='status'>{deployment ? <Status run value={deployment.status} /> : null}</div>
					{/* The row truncates the branch and shortens the commit; here both read in full. */}
					{deployment?.branch ? (
						<p className='font-mono text-xs wrap-anywhere text-muted'>{deployment.branch}</p>
					) : null}
					{deployment?.commit_sha ? (
						<p className='font-mono text-xs wrap-anywhere text-muted'>{deployment.commit_sha}</p>
					) : null}
					{steps.length === 0 ? (
						<span className='text-sm text-muted'>{pipelineNote(deployment)}</span>
					) : (
						<Timeline
							label='Pipeline'
							steps={steps.map(step => ({
								id: step.id,
								name: step.name,
								status: step.status,
								// A running step re-renders only on a stream event, so a count would stall in a quiet pull.
								detail: step.finished_at ? duration(step.started_at, step.finished_at) : undefined,
							}))}
						/>
					)}
					{isRunning ? (
						<Confirm
							title={`Cancel deployment #${deployment.number}?`}
							description='The pipeline stops at the step it is on.'
							action='Cancel deployment'
							dismiss='Keep running'
							icon={IconX}
							onConfirm={() => cancel.mutate()}
						>
							<Button variant='danger' loading={cancel.isPending} disabled={cancel.isSuccess}>
								<IconX size={16} stroke={1.75} />
								Cancel deployment
							</Button>
						</Confirm>
					) : null}
				</div>

				{/* LogViewer's className sizes its log box, not its root, so the flex item is this wrapper. */}
				<div className='min-w-0 flex-1'>
					<LogViewer
						lines={logLines}
						build
						inset
						waiting={live && (!deployment || isRunning)}
						className='h-[60dvh]'
					/>
				</div>
			</div>
		</div>
	)
}

/** What the pipeline column says before it has a step to show. */
function pipelineNote(deployment: Deployment | null) {
	if (!deployment) return 'Connecting…'
	if (deployment.status === 'queued' || deployment.status === 'running') return 'Waiting for the runner…'
	return 'No steps recorded.'
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
