import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Cell, ErrorText, Page, Row, Section, Skeleton, Table } from '../components/primitives'
import { api } from '../lib/api'
import { bytes, since } from '../lib/format'

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

	return (
		<Page title='Volumes'>
			<Section title='All volumes' description='deleting a volume destroys its data'>
				<ErrorText error={remove.error} />
				{volumes.isLoading ? (
					<Skeleton rows={4} />
				) : (
					<Table head={['Name', 'Driver', 'Size', 'In use', 'Created', '']}>
						{volumes.data?.map(volume => (
							<Row key={volume.Name}>
								<Cell mono>{volume.Name}</Cell>
								<Cell mono>{volume.Driver}</Cell>
								<Cell mono>{volume.UsageData ? bytes(volume.UsageData.Size) : '-'}</Cell>
								<Cell mono>{volume.UsageData ? volume.UsageData.RefCount : '-'}</Cell>
								<Cell>{since(volume.CreatedAt)}</Cell>
								<Cell right>
									{pendingDelete === volume.Name ? (
										<span className='flex justify-end gap-1.5'>
											<Button variant='danger' onClick={() => remove.mutate(volume.Name)}>
												confirm delete
											</Button>
											<Button variant='ghost' onClick={() => setPendingDelete(null)}>
												cancel
											</Button>
										</span>
									) : (
										<Button variant='ghost' onClick={() => setPendingDelete(volume.Name)}>
											delete
										</Button>
									)}
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Section>
		</Page>
	)
}
