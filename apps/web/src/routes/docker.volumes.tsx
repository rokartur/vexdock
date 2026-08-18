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
		cell.accessor(volume => volume.Name, { id: 'name', header: 'Name', meta: { mono: true } }),
		cell.accessor(volume => volume.Driver, { id: 'driver', header: 'Driver', meta: { mono: true } }),
		cell.accessor(volume => volume.UsageData?.Size ?? -1, {
			id: 'size',
			header: 'Size',
			cell: ({ row }) => (row.original.UsageData ? bytes(row.original.UsageData.Size) : '-'),
			meta: { mono: true },
		}),
		cell.accessor(volume => volume.UsageData?.RefCount ?? -1, {
			id: 'in-use',
			header: 'In use',
			cell: ({ row }) => (row.original.UsageData ? row.original.UsageData.RefCount : '-'),
			meta: { mono: true },
		}),
		cell.accessor(volume => volume.CreatedAt, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => since(row.original.CreatedAt),
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row }) =>
				pendingDelete === row.original.Name ? (
					<span className='flex justify-end gap-1.5'>
						<Button variant='danger' onClick={() => remove(row.original.Name)}>
							confirm delete
						</Button>
						<Button variant='ghost' onClick={() => setPendingDelete(null)}>
							cancel
						</Button>
					</span>
				) : (
					<Button variant='ghost' onClick={() => setPendingDelete(row.original.Name)}>
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
					getRowId={volume => volume.Name}
					empty='No volumes.'
				/>
			</Section>
		</Page>
	)
}
