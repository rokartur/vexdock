import { useMemo } from 'react'
import { IconDatabase, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Confirm, ErrorText, IconButton, Page, Refresh, Section } from '../components/primitives'
import { api, type VolumeSummary } from '../lib/api'
import { bytes, since } from '../lib/format'

function volumeTableColumns(remove: (name: string) => void): Columns<VolumeSummary> {
	const cell = columnsFor<VolumeSummary>()
	return [
		cell.accessor(volume => volume.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2'>
					<IconDatabase className='size-4 text-muted-foreground' />
					<span className='font-mono text-label'>{row.original.name}</span>
				</span>
			),
		}),
		cell.accessor(volume => volume.driver, { id: 'driver', header: 'Driver', meta: { mono: true } }),
		cell.accessor(volume => volume.size, {
			id: 'size',
			header: 'Size',
			cell: ({ row }) => (row.original.size < 0 ? '-' : bytes(row.original.size)),
			meta: { mono: true },
		}),
		cell.accessor(volume => volume.ref_count, {
			id: 'in-use',
			header: 'In use',
			cell: ({ row }) => (row.original.ref_count < 0 ? '-' : row.original.ref_count),
			meta: { mono: true },
		}),
		cell.accessor(volume => volume.created_at, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => <span className='text-muted-foreground'>{since(row.original.created_at)}</span>,
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Confirm
					title={`Delete ${row.original.name}?`}
					description='Everything stored in the volume is destroyed. There is no undo.'
					onConfirm={() => remove(row.original.name)}
				>
					<IconButton icon={IconTrash} label='Delete' />
				</Confirm>
			),
		}),
	]
}

export const Route = createFileRoute('/docker/volumes')({ component: VolumesPage })

function VolumesPage() {
	const queryClient = useQueryClient()

	const volumes = useQuery({ queryKey: ['volumes'], queryFn: api.volumes })

	const remove = useMutation({
		mutationFn: (name: string) => api.removeVolume(name),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['volumes'] }),
	})

	const data = volumes.data ?? []
	const { mutate: removeVolume } = remove
	const columns = useMemo(() => volumeTableColumns(removeVolume), [removeVolume])

	return (
		<Page>
			<Section
				title='All volumes'
				description='deleting a volume destroys its data'
				actions={<Refresh onClick={() => volumes.refetch()} busy={volumes.isFetching} />}
			>
				<ErrorText error={remove.error} />
				<DataTable
					data={data}
					columns={columns}
					loading={volumes.isLoading}
					getRowId={volume => volume.name}
					filter='Filter volumes'
					empty='No volumes'
				/>
			</Section>
		</Page>
	)
}
