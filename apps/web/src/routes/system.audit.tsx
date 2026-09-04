import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Page, Refresh, Section } from '../components/primitives'
import { api, type AuditEntry } from '../lib/api'
import { since } from '../lib/format'

const auditTableColumns: Columns<AuditEntry> = (() => {
	const cell = columnsFor<AuditEntry>()
	return [
		cell.accessor(entry => entry.at, {
			id: 'when',
			header: 'When',
			cell: ({ row }) => (
				<span className='text-muted-foreground' title={new Date(row.original.at).toLocaleString()}>
					{since(row.original.at)}
				</span>
			),
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

export const Route = createFileRoute('/system/audit')({ component: Audit })

function Audit() {
	const auditLog = useQuery({ queryKey: ['audit'], queryFn: api.audit })
	const data = auditLog.data ?? []

	return (
		<Page>
			<Section
				title='Audit'
				description={`${data.length} entries, newest first`}
				actions={<Refresh onClick={() => auditLog.refetch()} busy={auditLog.isFetching} />}
			>
				<DataTable
					data={data}
					columns={auditTableColumns}
					loading={auditLog.isLoading}
					getRowId={entry => entry.id}
					filter='Filter entries'
					empty='Nothing recorded yet'
				/>
			</Section>
		</Page>
	)
}
