import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Page, Refresh, Section, Status } from '../components/primitives'
import { api, type AuditEntry, type Certificate } from '../lib/api'
import { bytes, since } from '../lib/format'

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

const certificateTableColumns: Columns<Certificate> = (() => {
	const cell = columnsFor<Certificate>()
	return [
		cell.accessor(row => row.hostname, { id: 'hostname', header: 'Domain', meta: { mono: true } }),
		cell.accessor(row => row.issuer || '-', { id: 'issuer', header: 'Issuer' }),
		cell.accessor(row => row.status, {
			id: 'status',
			header: 'Status',
			cell: ({ row }) => <Status value={row.original.status} />,
		}),
		cell.accessor(row => row.expires_at ?? '', {
			id: 'expires',
			header: 'Expires',
			meta: { mono: true },
			cell: ({ row }) => (row.original.expires_at ? row.original.expires_at.slice(0, 10) : '-'),
		}),
		cell.accessor(row => row.last_renewed_at ?? '', {
			id: 'renewed',
			header: 'Last renewed',
			meta: { mono: true },
			cell: ({ row }) => (row.original.last_renewed_at ? row.original.last_renewed_at.slice(0, 10) : '-'),
		}),
	]
})()

const auditTableColumns: Columns<AuditEntry> = (() => {
	const cell = columnsFor<AuditEntry>()
	return [
		cell.accessor(entry => entry.at, {
			id: 'when',
			header: 'When',
			cell: ({ row }) => since(row.original.at),
		}),
		cell.accessor(entry => entry.actor, { id: 'actor', header: 'Actor' }),
		cell.accessor(entry => `${entry.method} ${entry.path}`, {
			id: 'action',
			header: 'Action',
			meta: { mono: true },
		}),
		cell.accessor(entry => entry.status, { id: 'status', header: 'Status', meta: { mono: true } }),
		cell.accessor(entry => entry.credential, { id: 'via', header: 'Via' }),
		cell.accessor(entry => entry.client_ip || '-', { id: 'from', header: 'From', meta: { mono: true } }),
	]
})()

export const Route = createFileRoute('/system/')({ component: SystemOverview })

function SystemOverview() {
	const info = useQuery({ queryKey: ['system', 'info'], queryFn: api.systemInfo })
	const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 })
	const certificates = useQuery({ queryKey: ['certificates'], queryFn: api.certificates })
	const auditLog = useQuery({ queryKey: ['audit'], queryFn: api.audit, refetchInterval: 30_000 })

	const healthRows = useMemo<HealthRow[]>(
		() => Object.entries(health.data?.checks ?? {}).map(([name, result]) => ({ name, result })),
		[health.data],
	)
	const certificateData = certificates.data ?? []
	const auditData = auditLog.data ?? []

	return (
		<Page title='System'>
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

			<Section
				title='Certificates'
				actions={<Refresh onClick={() => certificates.refetch()} busy={certificates.isFetching} />}
			>
				<DataTable
					data={certificateData}
					columns={certificateTableColumns}
					loading={certificates.isLoading}
					getRowId={row => row.id}
					empty='No certificates issued yet.'
				/>
			</Section>
			<Section
				title='Audit'
				description={`${auditData.length} entries, newest first`}
				actions={<Refresh onClick={() => auditLog.refetch()} busy={auditLog.isFetching} />}
			>
				<DataTable
					data={auditData}
					columns={auditTableColumns}
					loading={auditLog.isLoading}
					getRowId={entry => entry.id}
					empty='Nothing recorded yet.'
				/>
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
