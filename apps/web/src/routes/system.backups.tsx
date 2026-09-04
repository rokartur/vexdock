import { IconArchive, IconDatabase } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, ErrorText, Page, Refresh, Section } from '../components/primitives'
import { api, type Backup } from '../lib/api'
import { bytes, since } from '../lib/format'

const backupTableColumns: Columns<Backup> = (() => {
	const cell = columnsFor<Backup>()
	return [
		cell.accessor(backup => backup.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2'>
					<IconArchive className='size-4 text-muted-foreground' />
					<span className='font-mono text-label'>{row.original.name}</span>
				</span>
			),
		}),
		cell.accessor(backup => (backup.has_volumes ? 'platform + volumes' : 'platform'), {
			id: 'contents',
			header: 'Contents',
		}),
		cell.accessor(backup => backup.size_bytes, {
			id: 'size',
			header: 'Size',
			meta: { mono: true },
			cell: ({ row }) => bytes(row.original.size_bytes),
		}),
		cell.accessor(backup => backup.created_at, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => <span className='text-muted-foreground'>{since(row.original.created_at)}</span>,
		}),
		cell.accessor(backup => backup.path, { id: 'path', header: 'Path', meta: { mono: true } }),
	]
})()

export const Route = createFileRoute('/system/backups')({ component: BackupsPage })

function BackupsPage() {
	const queryClient = useQueryClient()
	const backups = useQuery({ queryKey: ['backups'], queryFn: api.backups })

	const create = useMutation({
		mutationFn: (includeVolumes: boolean) => api.createBackup(includeVolumes),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
	})

	const data = backups.data ?? []

	return (
		<Page>
			<Section
				title='Snapshots'
				description='database, proxy config and certificates, optionally with application volumes'
				actions={
					<div className='flex items-center gap-2'>
						<Button onClick={() => create.mutate(false)} disabled={create.isPending}>
							<IconArchive />
							Platform only
						</Button>
						<Button variant='primary' onClick={() => create.mutate(true)} disabled={create.isPending}>
							<IconDatabase />
							{create.isPending ? 'Creating…' : 'Include volumes'}
						</Button>
						<Refresh onClick={() => backups.refetch()} busy={backups.isFetching} />
					</div>
				}
			>
				<ErrorText error={create.error} />
				<DataTable
					data={data}
					columns={backupTableColumns}
					loading={backups.isLoading}
					getRowId={backup => backup.name}
					filter='Filter backups'
					empty='No backups yet. One is taken automatically before every platform update.'
				/>
			</Section>
		</Page>
	)
}
