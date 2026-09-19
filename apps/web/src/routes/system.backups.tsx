import { useMemo } from 'react'
import { IconArchive, IconDatabase, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import {
	Button,
	Confirm,
	ErrorText,
	IconButton,
	Page,
	Refresh,
	RelativeTime,
	Section,
	StatStrip,
} from '../components/primitives'
import { api, type Backup } from '../lib/api'
import { bytes } from '../lib/format'

function backupTableColumns(remove: (name: string) => void): Columns<Backup> {
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
		cell.accessor(backup => (backup.has_volumes ? 'config + data' : 'config'), {
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
			cell: ({ row }) => <RelativeTime at={row.original.created_at} />,
		}),
		cell.accessor(backup => backup.path, { id: 'path', header: 'Path', meta: { mono: true } }),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Confirm
					title={`Delete ${row.original.name}?`}
					description='The snapshot and everything archived in it is removed from disk. There is no undo.'
					onConfirm={() => remove(row.original.name)}
				>
					<IconButton icon={IconTrash} label='Delete' />
				</Confirm>
			),
		}),
	]
}

export const Route = createFileRoute('/system/backups')({ component: BackupsPage })

function BackupsPage() {
	const queryClient = useQueryClient()
	const backups = useQuery({ queryKey: ['backups'], queryFn: api.backups })

	const create = useMutation({
		mutationFn: api.createBackup,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
	})

	const remove = useMutation({
		mutationFn: api.deleteBackup,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
	})

	const data = backups.data ?? []
	const { mutate: removeBackup } = remove
	const columns = useMemo(() => backupTableColumns(removeBackup), [removeBackup])

	// A snapshot is named for the minute it was taken and the API sorts that name descending.
	const newest = data.at(0)

	return (
		<Page>
			{newest ? (
				<StatStrip
					className='mb-4'
					items={[
						{ label: 'Snapshots', value: data.length },
						{ label: 'With data', value: data.filter(backup => backup.has_volumes).length },
						{
							label: 'On disk',
							value: bytes(data.reduce((total, backup) => total + backup.size_bytes, 0)),
						},
						{ label: 'Newest', value: <RelativeTime at={newest.created_at} /> },
					]}
				/>
			) : null}
			<Section
				title='Snapshots'
				description='database, proxy config and certificates, optionally with application volumes'
				actions={
					<div className='flex items-center gap-2'>
						<Button onClick={() => create.mutate(false)} disabled={create.isPending}>
							<IconArchive />
							Config only
						</Button>
						<Button variant='primary' onClick={() => create.mutate(true)} disabled={create.isPending}>
							<IconDatabase />
							{create.isPending ? 'Creating…' : 'Config + data'}
						</Button>
						<Refresh onClick={() => backups.refetch()} busy={backups.isFetching} />
					</div>
				}
			>
				<ErrorText error={create.error ?? remove.error} />
				<DataTable
					data={data}
					columns={columns}
					loading={backups.isLoading}
					error={backups.error}
					getRowId={backup => backup.name}
					filter='Filter backups'
					empty='No backups yet. One is taken automatically before every platform update.'
				/>
			</Section>
		</Page>
	)
}
