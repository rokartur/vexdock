import { type ReactNode, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { MetricCard, seriesOf, useHistory } from '../components/metric-chart'
import { Cell, Cells, Fact, Facts, Page, Refresh, Section, Status } from '../components/primitives'
import { api, type Certificate, type Domain, type HostPoint, type HostStats, type Project } from '../lib/api'
import { bytes, duration, percent, since, until } from '../lib/format'
import { useEventSource } from '../lib/sse'

/** The live stream carries a load average the recorded buckets do not. */
type HostSample = HostPoint & { load_average?: number }

/** Recorded buckets are stamped in unix seconds; live samples use the browser clock. */
const toMillis = (point: HostPoint): HostSample => ({ ...point, at: point.at * 1000 })

/** A cert this close to expiry reads as a warning: renewal should have happened. */
const EXPIRY_WARN_DAYS = 14

/** A domain row carries its certificate, joined once so cells stay dumb. */
type DomainRow = Domain & { certificate?: Certificate }

const domainColumns: Columns<DomainRow> = (() => {
	const cell = columnsFor<DomainRow>()
	return [
		cell.accessor('hostname', { header: 'Domain', meta: { mono: true } }),
		cell.accessor(({ certificate }) => certificate?.status ?? '', {
			id: 'certificate',
			header: 'Certificate',
			cell: ({ row: { original } }) =>
				original.certificate ? (
					<Status value={original.certificate.status} />
				) : (
					<span className='text-muted-foreground'>{original.https_enabled ? '-' : 'http'}</span>
				),
		}),
		cell.accessor(({ certificate }) => certificate?.expires_at ?? '', {
			id: 'expires',
			header: 'Expires',
			meta: { mono: true },
			cell: ({ row: { original } }) => {
				const expires = original.certificate?.expires_at
				if (!expires) return <span className='text-muted-foreground'>-</span>
				const days = (Date.parse(expires) - Date.now()) / 86_400_000
				return (
					<span className={days < EXPIRY_WARN_DAYS ? 'text-amber-400' : 'text-muted-foreground'}>
						{until(expires)}
					</span>
				)
			},
		}),
	]
})()

const projectColumns: Columns<Project> = (() => {
	const cell = columnsFor<Project>()
	return [
		cell.accessor('name', {
			header: 'Project',
			cell: ({ row: { original } }) => (
				<Link to='/projects/$projectId' params={{ projectId: original.id }} className='hover:underline'>
					{original.name}
				</Link>
			),
		}),
		cell.accessor(({ running_count, service_count }) => `${running_count}/${service_count}`, {
			id: 'services',
			header: 'Services',
			meta: { mono: true },
			cell: ({ row: { original } }) => (
				<span className={original.running_count === 0 ? 'text-muted-foreground' : undefined}>
					{original.running_count}/{original.service_count}
				</span>
			),
		}),
		cell.accessor(({ latest_deployment }) => latest_deployment?.created_at ?? '', {
			id: 'deploy',
			header: 'Last deploy',
			cell: ({ row: { original } }) =>
				original.latest_deployment ? (
					<span className='flex items-center gap-2'>
						<Status value={original.latest_deployment.status} />
						<span className='text-muted-foreground'>{since(original.latest_deployment.created_at)}</span>
					</span>
				) : (
					<span className='text-muted-foreground'>never</span>
				),
		}),
	]
})()

export const Route = createFileRoute('/')({ component: DashboardPage })

function DashboardPage() {
	const info = useQuery({ queryKey: ['system', 'info'], queryFn: api.systemInfo, refetchInterval: 15_000 })
	const recorded = useQuery({ queryKey: ['system', 'metrics'], queryFn: () => api.systemMetrics('30m') })
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, refetchInterval: 30_000 })
	const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
	const certificates = useQuery({ queryKey: ['certificates'], queryFn: api.certificates })
	const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks, refetchInterval: 30_000 })
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

	const domainRows = useMemo((): DomainRow[] => {
		const byDomain = new Map((certificates.data ?? []).map(certificate => [certificate.domain_id, certificate]))
		return (domains.data ?? []).map(domain => ({ ...domain, certificate: byDomain.get(domain.id) }))
	}, [domains.data, certificates.data])

	const feed = useMemo(() => {
		const items: { id: string; at: number; node: ReactNode }[] = []
		for (const { deployment, project_name } of info.data?.recent_deployments ?? []) {
			items.push({
				id: deployment.id,
				at: Date.parse(deployment.created_at),
				node: (
					<>
						<Link
							to='/projects/$projectId'
							params={{ projectId: deployment.project_id }}
							className='hover:underline'
						>
							{project_name || deployment.project_id}
						</Link>{' '}
						deploy{' '}
						<Link
							to='/deployments/$deploymentId'
							params={{ deploymentId: deployment.id }}
							className='font-mono hover:underline'
						>
							#{deployment.number}
						</Link>{' '}
						<Status value={deployment.status} />
						<span className='font-mono text-muted-foreground'>
							{duration(deployment.started_at, deployment.finished_at)}
						</span>
					</>
				),
			})
		}
		for (const task of tasks.data ?? []) {
			const run = task.last_run
			if (!run) continue
			let outcome = 'running'
			if (run.finished_at !== '') outcome = run.exit_code === 0 ? 'success' : 'failed'
			items.push({
				id: run.id,
				at: Date.parse(run.started_at),
				node: (
					<>
						task <span className='font-mono'>{task.name}</span> <Status value={outcome} />
						<span className='font-mono text-muted-foreground'>
							{duration(run.started_at, run.finished_at)}
						</span>
					</>
				),
			})
		}
		return items.toSorted((a, b) => b.at - a.at).slice(0, 15)
	}, [info.data?.recent_deployments, tasks.data])

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
				<Cells>
					<MetricCard
						label='CPU'
						value={current ? percent(current.cpu_percent) : '-'}
						series={[seriesOf(history, sample => sample.cpu_percent)]}
						max={100}
						format={([cpu]) => percent(cpu)}
						hint={stats?.load_average === undefined ? undefined : `load ${stats.load_average.toFixed(2)}`}
					/>
					<MetricCard
						label='Memory'
						value={current ? bytes(current.memory_used) : '-'}
						series={[seriesOf(history, sample => sample.memory_used)]}
						max={current?.memory_total}
						format={([used]) => bytes(used)}
						hint={`of ${bytes(current?.memory_total ?? host?.memory_total)}`}
					/>
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
					<Cell label='Platform'>
						{/* Inside a cell, so the cell is the box: no second border. */}
						<Facts className='mt-1.5 gap-x-3 border-0 px-0'>
							<Fact
								label='Containers'
								value={`${info.data?.containers_running ?? 0} / ${info.data?.containers ?? 0}`}
							/>
							<Fact label='Images' value={info.data?.images ?? 0} />
							<Fact
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
							/>
						</Facts>
					</Cell>
				</Cells>
			</Section>

			<div className='grid items-start gap-x-6 lg:grid-cols-2'>
				<div>
					<Section title='Projects'>
						<DataTable
							data={projects.data ?? []}
							columns={projectColumns}
							loading={projects.isLoading}
							getRowId={project => project.id}
							empty={
								<>
									No projects yet.{' '}
									<Link to='/projects' className='underline'>
										Create one
									</Link>{' '}
									to get started.
								</>
							}
						/>
					</Section>
					<Section title='Domains' description='certificate expiry'>
						<DataTable
							data={domainRows}
							columns={domainColumns}
							loading={domains.isLoading}
							getRowId={domain => domain.id}
							empty='No domains yet.'
						/>
					</Section>
				</div>
				<Section
					title='Activity'
					description='deploys and task runs'
					actions={
						<Refresh
							onClick={() => {
								void info.refetch()
								void tasks.refetch()
							}}
							busy={info.isFetching || tasks.isFetching}
						/>
					}
				>
					{feed.length === 0 ? (
						<div className='rounded-lg border px-3 py-8 text-center text-body text-muted-foreground'>
							No activity yet.
						</div>
					) : (
						<div className='divide-y rounded-lg border px-3'>
							{feed.map(item => (
								<div key={item.id} className='flex items-baseline gap-3 py-1.5 text-body'>
									<span className='w-16 shrink-0 font-mono text-label text-muted-foreground'>
										{since(item.at / 1000)}
									</span>
									<span className='flex min-w-0 flex-wrap items-baseline gap-x-1.5'>{item.node}</span>
								</div>
							))}
						</div>
					)}
				</Section>
			</div>
		</Page>
	)
}
