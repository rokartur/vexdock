import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, ErrorText, Page, Refresh, Section } from '../components/primitives'
import { api, type VolumeSummary } from '../lib/api'
import { bytes, since } from '../lib/format'

type VolumeActions = {
	pendingDelete: string | null
	setPendingDelete: (name: string | null) => void
	remove: (name: string) => void
}

function volumeTableColumns({ pendingDelete, setPendingDelete, remove }: VolumeActions): Columns<VolumeSummary> {
	const cell = columnsFor<VolumeSummary>()
	return [
		cell.accessor(volume => volume.name, { id: 'name', header: 'Name', meta: { mono: true } }),
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
			cell: ({ row }) => since(row.original.created_at),
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) =>
				pendingDelete === row.original.name ? (
					<span className='flex justify-end gap-1.5'>
						<Button variant='danger' onClick={() => remove(row.original.name)}>
							confirm delete
						</Button>
						<Button variant='ghost' onClick={() => setPendingDelete(null)}>
							cancel
						</Button>
					</span>
				) : (
					<Button variant='ghost' onClick={() => setPendingDelete(row.original.name)}>
						delete
					</Button>
				),
		}),
	]
}

export const Route = createFileRoute('/docker/volumes')({ component: VolumesPage })

function VolumesPage() {
	const queryClient = useQueryClient()
	const [pendingDelete, setPendingDelete] = useState<string | null>(null)

	const volumes = useQuery({ queryKey: ['volumes'], queryFn: api.volumes })

	const remove = useMutation({
		mutationFn: (name: string) => api.removeVolume(name),
		onSuccess: async () => {
			setPendingDelete(null)
			await queryClient.invalidateQueries({ queryKey: ['volumes'] })
		},
	})

	const data = volumes.data ?? []
	const { mutate: removeVolume } = remove
	const columns = useMemo(
		() => volumeTableColumns({ pendingDelete, setPendingDelete, remove: removeVolume }),
		[pendingDelete, removeVolume],
	)

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
					empty='No volumes.'
				/>
			</Section>
		</Page>
	)
}
