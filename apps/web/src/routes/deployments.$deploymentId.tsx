import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { api, type Deployment, type DeploymentStep } from '../lib/api'
import { clock, duration, shortSha } from '../lib/format'
import { Button, ErrorText, Section, Status } from '../components/ui'
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
      snapshot: (data) => {
        const payload = data as { deployment: Deployment; steps: DeploymentStep[] }
        setDeployment(payload.deployment)
        setSteps(payload.steps)
      },
      log: (data) => setLines((current) => [...current, data as LogLine]),
      'step.started': (data) => upsertStep(setSteps, data as DeploymentStep),
      'step.success': (data) => upsertStep(setSteps, data as DeploymentStep),
      'step.failed': (data) => upsertStep(setSteps, data as DeploymentStep),
      'deployment.started': (data) => setDeployment(data as Deployment),
      'deployment.success': (data) => setDeployment(data as Deployment),
      'deployment.failed': (data) => setDeployment(data as Deployment),
      'deployment.cancelled': (data) => setDeployment(data as Deployment),
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
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          {deployment ? (
            <Link
              to="/projects/$projectId/deployments"
              params={{ projectId: deployment.project_id }}
              className="text-[12px] text-[#8a8a8a] hover:text-white"
            >
              deployments
            </Link>
          ) : null}
          <span className="text-[#3a3a3a]">/</span>
          <h1 className="text-[15px] font-medium">#{deployment?.number ?? ''}</h1>
          {deployment ? <Status value={deployment.status} /> : null}
          <span className="font-mono text-[12px] text-[#8a8a8a]">
            {deployment?.branch} {shortSha(deployment?.commit_sha)}
          </span>
        </div>
        <div className="flex gap-2">
          {isRunning ? (
            <Button variant="danger" onClick={() => cancel.mutate()}>
              Cancel
            </Button>
          ) : null}
          {!isRunning && deployment?.commit_sha ? (
            <Button onClick={() => rollback.mutate()}>Redeploy this commit</Button>
          ) : null}
        </div>
      </div>

      <ErrorText error={cancel.error ?? rollback.error} />
      {deployment?.error ? <p className="mb-3 text-[12px] text-[#ff5f56]">{deployment.error}</p> : null}

      <Section title="Pipeline">
        <ol className="border-t border-[#1f1f1f]">
          {steps.length === 0 ? (
            <li className="py-3 text-[12px] text-[#8a8a8a]">Waiting for the runner…</li>
          ) : (
            steps.map((step) => (
              <li key={step.id} className="flex items-center gap-4 border-b border-[#141414] py-1.5">
                <span className="w-28 font-mono text-[12px]">{step.name}</span>
                <Status value={step.status} />
                <span className="font-mono text-[11px] text-[#8a8a8a]">
                  {duration(step.started_at, step.finished_at)}
                </span>
              </li>
            ))
          )}
        </ol>
      </Section>

      <Section title="Log" description={live ? 'streaming' : 'finished'}>
        <div className="h-[50vh] overflow-auto border border-[#1f1f1f] bg-[#050505] p-2 font-mono text-[12px] leading-[1.45]">
          {lines.length === 0 ? (
            <p className="text-[#5a5a5a]">
              {steps.some((step) => step.output)
                ? steps.map((step) => step.output).filter(Boolean).join('\n')
                : 'No output yet.'}
            </p>
          ) : (
            lines.map((line, index) => (
              <div key={index} className="flex gap-3">
                <span className="shrink-0 text-[#4a4a4a]">{clock(line.at)}</span>
                <span className="text-[#d4d4d4] break-all whitespace-pre-wrap">{line.text}</span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </Section>
    </>
  )
}

function upsertStep(setSteps: React.Dispatch<React.SetStateAction<DeploymentStep[]>>, step: DeploymentStep) {
  setSteps((current) => {
    const index = current.findIndex((item) => item.id === step.id)
    if (index === -1) return [...current, step]
    const next = [...current]
    next[index] = step
    return next
  })
}
