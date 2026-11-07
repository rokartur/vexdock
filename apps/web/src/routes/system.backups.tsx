import { useMemo } from 'react'
import { IconArchive, IconDatabase, IconTrash } from '@tabler/icons-react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import {
	Confirm,
	EmptyState,
	ErrorText,
	IconButton,
	Page,
	Refresh,
	RelativeTime,
	Section,
	StatStrip,
} from '../components/primitives'
import { SplitButton } from '../components/ui/split-button'
import { api, type Backup } from '../lib/api'
import { bytes } from '../lib/format'
import { preload } from '../lib/queries'

function backupTableColumns(remove: (name: string) => void, removing: string | undefined): Columns<Backup> {
	const cell = columnsFor<Backup>()
	return [
		cell.accessor(backup => backup.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2'>
					<IconArchive stroke={1.75} className='size-4 text-muted' />
					<span className='font-mono text-xs'>{row.original.name}</span>
				</span>
			),
		}),
		cell.accessor(backup => (backup.has_volumes ? 'Config and volumes' : 'Config only'), {
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
					description='The backup and everything archived in it is removed from disk. There is no undo.'
					action='Delete backup'
					onConfirm={() => remove(row.original.name)}
				>
					<IconButton
						icon={IconTrash}
						label={`Delete ${row.original.name}`}
						loading={removing === row.original.name}
						disabled={removing !== undefined}
					/>
				</Confirm>
			),
		}),
	]
}

const backupsQuery = queryOptions({ queryKey: ['backups'], queryFn: api.backups })

export const Route = createFileRoute('/system/backups')({
	loader: ({ context: { queryClient } }) => preload(queryClient, backupsQuery),
	component: BackupsPage,
})

function BackupsPage() {
	const queryClient = useQueryClient()
	const backups = useQuery(backupsQuery)

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
	const removing = remove.isPending ? remove.variables : undefined
	const columns = useMemo(() => backupTableColumns(removeBackup, removing), [removeBackup, removing])

	// A backup is named for the minute it was taken and the API sorts that name descending.
	const newest = data.at(0)

	return (
		<Page fill>
			{newest ? (
				<StatStrip
					className='mb-4'
					items={[
						{ label: 'With volumes', value: data.filter(backup => backup.has_volumes).length },
						{
							label: 'On disk',
							value: bytes(data.reduce((total, backup) => total + backup.size_bytes, 0)),
						},
						{ label: 'Newest', value: <RelativeTime at={newest.created_at} /> },
					]}
				/>
			) : null}
			<Section
				title='Backups'
				total={backups.data?.length}
				fill
				actions={
					<>
						<Refresh onClick={() => backups.refetch()} />
						<SplitButton
							label={create.isPending ? 'Backing up…' : 'Back up config and volumes'}
							size='sm'
							icon={<IconDatabase size={16} stroke={1.75} />}
							onClick={() => create.mutate(true)}
							loading={create.isPending}
							actions={[
								{
									label: 'Back up config only',
									icon: <IconArchive size={16} stroke={1.75} />,
									onSelect: () => create.mutate(false),
								},
							]}
						/>
					</>
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
					empty={
						<EmptyState
							title='No backups yet'
							description='One is taken automatically before every platform update. Back up config and volumes takes one now.'
						/>
					}
				/>
			</Section>
		</Page>
	)
}
