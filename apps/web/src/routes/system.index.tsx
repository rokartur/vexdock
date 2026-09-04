import { useMemo } from 'react'
import { IconActivity } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Fact, Facts, Page, Refresh, Section, Status } from '../components/primitives'
import { api } from '../lib/api'
import { bytes } from '../lib/format'

type HealthRow = { name: string; result: string }

const healthTableColumns: Columns<HealthRow> = (() => {
	const cell = columnsFor<HealthRow>()
	return [
		cell.accessor(row => row.name, {
			id: 'check',
			header: 'Check',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2'>
					<IconActivity className='size-4 text-muted-foreground' />
					<span className='font-mono text-label'>{row.original.name}</span>
				</span>
			),
		}),
		cell.accessor(row => row.result, {
			id: 'result',
			header: 'Result',
			cell: ({ row }) =>
				row.original.result === 'ok' ? (
					<Status value='healthy' />
				) : (
					<span className='text-destructive'>{row.original.result}</span>
				),
		}),
	]
})()

export const Route = createFileRoute('/system/')({ component: SystemOverview })

function SystemOverview() {
	const info = useQuery({ queryKey: ['system', 'info'], queryFn: api.systemInfo })
	const health = useQuery({ queryKey: ['health'], queryFn: api.health })

	const healthRows = useMemo<HealthRow[]>(
		() => Object.entries(health.data?.checks ?? {}).map(([name, result]) => ({ name, result })),
		[health.data],
	)

	return (
		<Page>
			<div className='grid items-start gap-x-7 lg:grid-cols-2'>
				<Section title='Health' actions={<Refresh onClick={() => health.refetch()} busy={health.isFetching} />}>
					<DataTable
						data={healthRows}
						columns={healthTableColumns}
						loading={health.isLoading}
						getRowId={row => row.name}
						empty='No checks reported'
					/>
				</Section>

				<Section title='Host'>
					<Facts>
						<Fact label='Platform version' value={info.data?.version ?? '-'} />
						<Fact label='Docker' value={info.data?.host.docker_version ?? '-'} />
						<Fact label='OS' value={info.data?.host.os ?? '-'} />
						<Fact label='Architecture' value={info.data?.host.architecture ?? '-'} />
						<Fact label='CPUs' value={info.data?.host.cpus ?? '-'} />
						<Fact label='Memory' value={bytes(info.data?.host.memory_total)} />
						<Fact
							label='Containers'
							value={`${info.data?.containers_running ?? 0} / ${info.data?.containers ?? 0}`}
						/>
						<Fact label='Images' value={info.data?.images ?? 0} />
					</Facts>
				</Section>
			</div>
		</Page>
	)
}
