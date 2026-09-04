import { IconCertificate } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Page, Refresh, Section, Status } from '../components/primitives'
import { api, type Certificate } from '../lib/api'

const certificateTableColumns: Columns<Certificate> = (() => {
	const cell = columnsFor<Certificate>()
	return [
		cell.accessor(row => row.hostname, {
			id: 'hostname',
			header: 'Domain',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2'>
					<IconCertificate className='size-4 text-muted-foreground' />
					<span className='font-mono text-label'>{row.original.hostname}</span>
				</span>
			),
		}),
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
			cell: ({ row }) => (
				<span className='text-muted-foreground'>
					{row.original.expires_at ? row.original.expires_at.slice(0, 10) : '-'}
				</span>
			),
		}),
		cell.accessor(row => row.last_renewed_at ?? '', {
			id: 'renewed',
			header: 'Last renewed',
			meta: { mono: true },
			cell: ({ row }) => (
				<span className='text-muted-foreground'>
					{row.original.last_renewed_at ? row.original.last_renewed_at.slice(0, 10) : '-'}
				</span>
			),
		}),
	]
})()

export const Route = createFileRoute('/system/certificates')({ component: Certificates })

function Certificates() {
	const certificates = useQuery({ queryKey: ['certificates'], queryFn: api.certificates })
	const data = certificates.data ?? []

	return (
		<Page>
			<Section
				title='Certificates'
				description={`${data.length} issued`}
				actions={<Refresh onClick={() => certificates.refetch()} busy={certificates.isFetching} />}
			>
				<DataTable
					data={data}
					columns={certificateTableColumns}
					loading={certificates.isLoading}
					getRowId={row => row.id}
					filter='Filter certificates'
					empty='No certificates issued yet'
				/>
			</Section>
		</Page>
	)
}
