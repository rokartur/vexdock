import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { MetricCard, seriesOf, useHistory } from '../components/metric-chart'
import { Cell, Cells, Page, Refresh, Section, Status } from '../components/primitives'
import { api, type HostPoint, type HostStats } from '../lib/api'
import { bytes, duration, percent, shortSha, since } from '../lib/format'
import { useEventSource } from '../lib/sse'

/** The live stream carries a load average the recorded buckets do not. */
type HostSample = HostPoint & { load_average?: number }

/** Recorded buckets are stamped in unix seconds; live samples use the browser clock. */
const toMillis = (point: HostPoint): HostSample => ({ ...point, at: point.at * 1000 })

export const Route = createFileRoute('/')({ component: DashboardPage })

function DashboardPage() {
	const info = useQuery({ queryKey: ['system', 'info'], queryFn: api.systemInfo, refetchInterval: 15_000 })
	const recorded = useQuery({ queryKey: ['system', 'metrics'], queryFn: () => api.systemMetrics('30m') })
	// Same key the shell uses, so this rides its cache instead of re-fetching.
	const version = useQuery({ queryKey: ['version'], queryFn: api.version, refetchInterval: 60_000 })
	const [stats, setStats] = useState<HostSample | null>(null)

	useEventSource('/api/system/stats', {
		stats: data => setStats({ ...(data as HostStats), at: Date.now() }),
	})

	const history = useHistory(
		stats,
		useMemo(() => (recorded.data ?? []).map(toMillis), [recorded.data]),
	)
	// Until the first live sample lands, the newest recorded bucket is the reading.
	const current = stats ?? history.at(-1)
	const diskUsed = current && current.disk_total > 0 ? current.disk_used / current.disk_total : 0
	const host = info.data?.host

	// The API already returns these newest-first, capped.
	const deployments = info.data?.recent_deployments ?? []

	return (
		<Page
			actions={
				host ? (
					<span className='truncate text-meta text-muted-foreground'>
						{[
							host.name,
							`${host.os}/${host.architecture}`,
							`${host.cpus} vCPU`,
							bytes(host.memory_total),
							`docker ${host.docker_version}`,
						].join(' · ')}
					</span>
				) : null
			}
		>
			<Section title='Host' description='live, 30m history'>
				{/* A host is judged on cpu and memory, so on the fleet page those two get
				    a row to themselves and a chart big enough to read a trend off. */}
				<Cells className='mb-2'>
					<MetricCard
						label='CPU'
						value={current ? percent(current.cpu_percent) : '-'}
						series={[seriesOf(history, sample => sample.cpu_percent)]}
						max={100}
						format={([cpu]) => percent(cpu)}
						hint={stats?.load_average === undefined ? undefined : `load ${stats.load_average.toFixed(2)}`}
						height={96}
					/>
					<MetricCard
						label='Memory'
						value={current ? bytes(current.memory_used) : '-'}
						series={[seriesOf(history, sample => sample.memory_used)]}
						max={current?.memory_total}
						format={([used]) => bytes(used)}
						hint={`of ${bytes(current?.memory_total ?? host?.memory_total)}`}
						height={96}
					/>
				</Cells>
				<Cells>
					{/* Disk moves in hours, so a line would be flat; the bar says more. */}
					<Cell
						label='Disk'
						value={current ? bytes(current.disk_used) : '-'}
						hint={`of ${bytes(current?.disk_total)} · ${percent(diskUsed * 100)}`}
					>
						<div className='mt-2.5 h-0.5 rounded-full bg-muted'>
							<div
								className='h-full rounded-full bg-foreground'
								style={{ width: percent(diskUsed * 100) }}
							/>
						</div>
					</Cell>
					<Cell
						label='Containers'
						value={`${info.data?.containers_running ?? 0} / ${info.data?.containers ?? 0}`}
						hint='running / total'
					/>
					<Cell label='Images' value={info.data?.images ?? 0} hint='on this host' />
					<Cell
						label='Version'
						value={
							version.data?.update_available ? (
								<Link to='/system/settings/about' className='text-amber-400 hover:underline'>
									{info.data?.version} · update
								</Link>
							) : (
								(info.data?.version ?? '-')
							)
						}
						hint={version.data?.update_available ? 'update available' : 'up to date'}
					/>
				</Cells>
			</Section>

			<Section
				title='Deployments'
				description='newest first, open one for its log'
				actions={<Refresh onClick={() => info.refetch()} busy={info.isFetching} />}
			>
				{deployments.length === 0 ? (
					<div className='rounded-xl border px-3 py-8 text-center text-body text-muted-foreground'>
						No deployments yet.
					</div>
				) : (
					<div className='divide-y rounded-xl border'>
						{deployments.map(({ deployment, project_name }) => (
							// The whole row opens the deployment page, which is where the
							// pipeline and the streamed log live.
							<Link
								key={deployment.id}
								to='/deployments/$deploymentId'
								params={{ deploymentId: deployment.id }}
								className='flex items-baseline gap-3 px-3 py-1.5 text-body first:rounded-t-xl last:rounded-b-xl hover:bg-muted/50'
							>
								<span className='w-16 shrink-0 font-mono text-label text-muted-foreground'>
									{since(deployment.created_at)}
								</span>
								<span className='truncate'>{project_name || deployment.project_id}</span>
								<span className='truncate font-mono text-muted-foreground'>
									{deployment.service_name || 'all'} · {shortSha(deployment.commit_sha)}
								</span>
								<span className='ml-auto flex shrink-0 items-baseline gap-3'>
									<Status value={deployment.status} />
									<span className='font-mono text-label text-muted-foreground'>
										{duration(deployment.started_at, deployment.finished_at)}
									</span>
									<span className='font-mono text-label text-muted-foreground'>
										#{deployment.number}
									</span>
								</span>
							</Link>
						))}
					</div>
				)}
			</Section>
		</Page>
	)
}
