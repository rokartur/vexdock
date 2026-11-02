import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { HealthStatus } from '../components/health-status'
import { Fact, Facts, Meter, Page, Refresh, RelativeTime, Section } from '../components/primitives'
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
				actions={<Refresh onClick={() => health.refetch()} busy={health.isFetching} />}
			/>

			<Section title='Host'>
				<Facts>
					<Fact label='Platform version' value={info.data?.version ?? '-'} />
					<Fact label='Docker' value={info.data?.host.docker_version ?? '-'} />
					<Fact label='OS' value={info.data?.host.os ?? '-'} />
					<Fact label='Architecture' value={info.data?.host.architecture ?? '-'} />
					<Fact label='CPUs' value={info.data?.host.cpus ?? '-'} />
					<Fact label='Memory' value={bytes(info.data?.host.memory_total)} />
					<Fact
						label='Containers running'
						value={
							<Meter
								label={`${info.data?.containers_running ?? 0} / ${info.data?.containers ?? 0}`}
								value={info.data?.containers_running ?? 0}
								max={info.data?.containers ?? 0}
							/>
						}
					/>
					<Fact label='Images' value={info.data?.images ?? 0} />
				</Facts>
			</Section>
		</Page>
	)
}
