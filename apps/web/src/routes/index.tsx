import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Cell, Empty, Page, Row, Section, Skeleton, Status, Table } from '../components/primitives'
import { api, type HostStats } from '../lib/api'
import { bytes, percent, since } from '../lib/format'
import { useEventSource } from '../lib/sse'

export const Route = createFileRoute('/')({ component: DashboardPage })

function DashboardPage() {
	const info = useQuery({ queryKey: ['system', 'info'], queryFn: api.systemInfo, refetchInterval: 15_000 })
	const [stats, setStats] = useState<HostStats | null>(null)

	useEventSource('/api/system/stats', {
		stats: data => setStats(data as HostStats),
	})

	return (
		<Page title='Dashboard'>
			<Section title='System'>
				<dl className='grid grid-cols-2 gap-x-8 gap-y-1 border-t border-border pt-2 sm:grid-cols-3 lg:grid-cols-6'>
					<Metric label='CPU' value={stats ? percent(stats.cpu_percent) : '-'} />
					<Metric
						label='RAM'
						value={
							stats && stats.memory_total > 0
								? `${bytes(stats.memory_used)} / ${bytes(stats.memory_total)}`
								: bytes(info.data?.host.memory_total)
						}
					/>
					<Metric
						label='Disk'
						value={
							stats && stats.disk_total > 0
								? `${bytes(stats.disk_used)} / ${bytes(stats.disk_total)}`
								: '-'
						}
					/>
					<Metric label='Projects' value={String(info.data?.projects ?? 0)} />
					<Metric
						label='Containers'
						value={`${info.data?.containers_running ?? 0} / ${info.data?.containers ?? 0}`}
					/>
					<Metric label='Images' value={String(info.data?.images ?? 0)} />
				</dl>
			</Section>

			<Section title='Deployments' description='most recent across all projects'>
				{info.isLoading ? (
					<Skeleton />
				) : (info.data?.recent_deployments.length ?? 0) === 0 ? (
					<Empty>
						No deployments yet.{' '}
						<Link to='/projects' className='underline'>
							Create a project
						</Link>{' '}
						to get started.
					</Empty>
				) : (
					<Table head={['', 'Project', 'Commit', 'Trigger', 'When']}>
						{info.data?.recent_deployments.map(({ deployment, project_name }) => (
							<Row key={deployment.id}>
								<Cell>
									<Status value={deployment.status} />
								</Cell>
								<Cell>
									<Link
										to='/projects/$projectId'
										params={{ projectId: deployment.project_id }}
										className='hover:underline'
									>
										{project_name || deployment.project_id}
									</Link>
								</Cell>
								<Cell mono>
									<Link
										to='/deployments/$deploymentId'
										params={{ deploymentId: deployment.id }}
										className='hover:underline'
									>
										#{deployment.number} {deployment.commit_sha.slice(0, 7)}
									</Link>
								</Cell>
								<Cell>{deployment.trigger}</Cell>
								<Cell>{since(deployment.created_at)}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Section>

			<Section title='Host'>
				<dl className='grid grid-cols-2 gap-x-8 gap-y-1 border-t border-border pt-2 lg:grid-cols-4'>
					<Metric label='Hostname' value={info.data?.host.name ?? '-'} />
					<Metric label='OS' value={info.data?.host.os ?? '-'} />
					<Metric label='Docker' value={info.data?.host.docker_version ?? '-'} />
					<Metric label='Architecture' value={info.data?.host.architecture ?? '-'} />
				</dl>
			</Section>
		</Page>
	)
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className='py-1'>
			<dt className='text-[12px] tracking-wide text-muted-foreground uppercase'>{label}</dt>
			<dd className='font-mono text-[14px]'>{value}</dd>
		</div>
	)
}
