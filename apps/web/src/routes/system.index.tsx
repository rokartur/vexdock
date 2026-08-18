import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Page, Refresh, Section, Status } from '../components/primitives'
import { api } from '../lib/api'
import { bytes } from '../lib/format'

type HealthRow = { name: string; result: string }

const healthTableColumns: Columns<HealthRow> = (() => {
	const cell = columnsFor<HealthRow>()
	return [
		cell.accessor(row => row.name, { id: 'check', header: 'Check', meta: { mono: true } }),
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
	const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 })

	const healthRows = useMemo<HealthRow[]>(
		() => Object.entries(health.data?.checks ?? {}).map(([name, result]) => ({ name, result })),
		[health.data],
	)

	return (
		<Page>
			<Section title='Health' actions={<Refresh onClick={() => health.refetch()} busy={health.isFetching} />}>
				<DataTable
					data={healthRows}
					columns={healthTableColumns}
					loading={health.isLoading}
					getRowId={row => row.name}
					empty='No checks reported.'
				/>
			</Section>

			<Section title='Host'>
				<dl className='grid grid-cols-2 gap-x-8 gap-y-1 border-t border-border pt-2 lg:grid-cols-4'>
					<Item label='Platform version' value={info.data?.version ?? '-'} />
					<Item label='Docker' value={info.data?.host.docker_version ?? '-'} />
					<Item label='OS' value={info.data?.host.os ?? '-'} />
					<Item label='Architecture' value={info.data?.host.architecture ?? '-'} />
					<Item label='CPUs' value={String(info.data?.host.cpus ?? '-')} />
					<Item label='Memory' value={bytes(info.data?.host.memory_total)} />
					<Item
						label='Containers'
						value={`${info.data?.containers_running ?? 0} / ${info.data?.containers ?? 0}`}
					/>
					<Item label='Images' value={String(info.data?.images ?? 0)} />
				</dl>
			</Section>
		</Page>
	)
}

function Item({ label, value }: { label: string; value: string }) {
	return (
		<div className='py-1'>
			<dt className='text-label tracking-wide text-muted-foreground uppercase'>{label}</dt>
			<dd className='font-mono text-body break-all'>{value}</dd>
		</div>
	)
}
