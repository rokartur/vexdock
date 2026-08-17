import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api, type ContainerStats } from '../lib/api'
import { bytes, percent, since } from '../lib/format'
import { Button, Section, Status } from '../components/primitives'
import { LogViewer } from '../components/log-viewer'
import { Terminal } from '../components/terminal'
import { useEventSource } from '../lib/sse'

export const Route = createFileRoute('/projects/$projectId/services/$serviceId')({ component: ServiceDetail })

const tabs = ['overview', 'logs', 'terminal'] as const
type Tab = (typeof tabs)[number]

function ServiceDetail() {
  const { projectId, serviceId } = Route.useParams()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>('overview')
  const [stats, setStats] = useState<ContainerStats | null>(null)

  const service = useQuery({
    queryKey: ['service', serviceId],
    queryFn: () => api.service(serviceId),
    refetchInterval: 5_000,
  })

  const running = service.data?.state === 'running'
  useEventSource(running ? `/api/services/${serviceId}/stats` : null, {
    stats: (data) => setStats(data as ContainerStats),
  })

  const act = useMutation({
    mutationFn: (action: 'start' | 'stop' | 'restart') => api.serviceAction(serviceId, action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['service', serviceId] }),
  })

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <Link to="/projects/$projectId" params={{ projectId }} className="text-[13px] text-muted-foreground hover:text-white">
            services
          </Link>
          <span className="text-zinc-700">/</span>
          <h2 className="text-[14px] font-medium">{service.data?.compose_service_name ?? serviceId}</h2>
          <Status value={service.data?.state || 'stopped'} />
        </div>
        <div className="flex gap-2">
          <Button onClick={() => act.mutate('start')}>Start</Button>
          <Button onClick={() => act.mutate('restart')}>Restart</Button>
          <Button onClick={() => act.mutate('stop')}>Stop</Button>
        </div>
      </div>

      <nav className="mb-4 flex gap-4 border-b border-border">
        {tabs.map((item) => (
          <button
            key={item}
            onClick={() => setTab(item)}
            className={`-mb-px border-b px-0.5 pb-1.5 text-[13px] capitalize ${
              tab === item ? 'border-white text-white' : 'border-transparent text-muted-foreground hover:text-white'
            }`}
          >
            {item}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <Section title="Overview">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-1 border-t border-border pt-2 lg:grid-cols-4">
            <Item label="Image" value={service.data?.image || '-'} />
            <Item label="Created" value={service.data?.created_unix ? since(service.data.created_unix) : '-'} />
            <Item label="Restarts" value={String(service.data?.restart_count ?? 0)} />
            <Item label="Health" value={service.data?.health || 'no healthcheck'} />
            <Item label="CPU" value={stats ? percent(stats.cpu_percent) : '-'} />
            <Item
              label="Memory"
              value={stats ? `${bytes(stats.memory_usage)} / ${bytes(stats.memory_limit)}` : '-'}
            />
            <Item label="Network" value={stats ? `${bytes(stats.network_rx)} rx / ${bytes(stats.network_tx)} tx` : '-'} />
            <Item label="Block IO" value={stats ? `${bytes(stats.block_read)} r / ${bytes(stats.block_write)} w` : '-'} />
            <Item label="PIDs" value={stats ? String(stats.pids) : '-'} />
            <Item label="Container" value={service.data?.container_id?.slice(0, 12) || '-'} />
          </dl>
        </Section>
      ) : null}

      {tab === 'logs' ? <LogViewer url={`/api/services/${serviceId}/logs`} /> : null}

      {tab === 'terminal' ? (
        running ? (
          <Terminal url={terminalUrl(serviceId)} />
        ) : (
          <p className="text-[13px] text-muted-foreground">Start the service to open a terminal.</p>
        )
      ) : null}
    </>
  )
}

function terminalUrl(serviceId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/services/${serviceId}/terminal`
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-1">
      <dt className="text-[12px] tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="font-mono text-[13px] break-all">{value}</dd>
    </div>
  )
}
