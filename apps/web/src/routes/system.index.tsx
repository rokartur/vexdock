import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { HealthStatus } from '../components/health-status'
import { ErrorText, Fact, Facts, Meter, Page, Refresh, RelativeTime, Section } from '../components/primitives'
import { Skeleton } from '../components/ui/skeleton'
import type { SystemInfo } from '../lib/api'
import { bytes } from '../lib/format'
import { healthQuery, preload, systemInfoQuery } from '../lib/queries'

export const Route = createFileRoute('/system/')({
	loader: ({ context: { queryClient } }) =>
		Promise.all([preload(queryClient, systemInfoQuery), preload(queryClient, healthQuery)]),
	component: SystemOverview,
})

function SystemOverview() {
	const info = useQuery(systemInfoQuery)
	const health = useQuery(healthQuery)

	return (
		<Page>
			<HealthStatus
				report={health.data}
				error={health.error}
				updatedAt={
					health.error ? (
						health.error.message
					) : health.dataUpdatedAt ? (
						<>
							Checked <RelativeTime at={new Date(health.dataUpdatedAt).toISOString()} />
						</>
					) : (
						'Not checked yet'
					)
				}
				actions={<Refresh label='Refresh health' onClick={() => health.refetch()} />}
			/>

			<Section title='Host' actions={<Refresh label='Refresh host' onClick={() => info.refetch()} />}>
				<HostFacts info={info} />
			</Section>
		</Page>
	)
}

function HostFacts({ info }: { info: UseQueryResult<SystemInfo> }) {
	if (!info.data) {
		if (info.isError) return <ErrorText error={info.error} />
		return <Skeleton label='Loading host' lines={4} className='rounded-surface border bg-surface p-5' />
	}
	const { host } = info.data
	// A failed refresh keeps the last facts under its error, the way DataTable keeps its rows.
	return (
		<>
			<ErrorText error={info.error} />
			<Facts>
				<Fact label='Platform version' value={info.data.version} />
				<Fact label='Docker' value={host.docker_version} />
				<Fact label='OS' value={host.os} />
				<Fact label='Architecture' value={host.architecture} />
				<Fact label='CPUs' value={host.cpus} />
				<Fact label='Memory' value={bytes(host.memory_total)} />
				<Fact
					label='Containers running'
					value={
						<Meter
							label={`${info.data.containers_running} / ${info.data.containers}`}
							value={info.data.containers_running}
							max={info.data.containers}
						/>
					}
				/>
				<Fact label='Images' value={info.data.images} />
			</Facts>
		</>
	)
}
