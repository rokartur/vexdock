import { useMemo } from 'react'
import { IconStack2, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { columnsFor, DataTable, type Columns } from '../components/data-table'
import { Confirm, ErrorText, IconButton, Page, Refresh, Section } from '../components/primitives'
import { api, type ImageSummary } from '../lib/api'
import { bytes, since } from '../lib/format'

function imageName(image: ImageSummary) {
	return image.repo_tags?.join(', ') || image.id.replace('sha256:', '').slice(0, 12)
}

function imageTableColumns(remove: (id: string) => void): Columns<ImageSummary> {
	const cell = columnsFor<ImageSummary>()
	return [
		cell.accessor(imageName, {
			id: 'repository',
			header: 'Repository',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2'>
					<IconStack2 className='size-4 text-muted-foreground' />
					<span className='font-mono text-label'>{imageName(row.original)}</span>
				</span>
			),
		}),
		cell.accessor(image => image.size, {
			id: 'size',
			header: 'Size',
			cell: ({ row }) => bytes(row.original.size),
			meta: { mono: true },
		}),
		cell.accessor(image => image.containers, {
			id: 'containers',
			header: 'Containers',
			cell: ({ row }) => (row.original.containers < 0 ? '-' : row.original.containers),
			meta: { mono: true },
		}),
		cell.accessor(image => image.created, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => <span className='text-muted-foreground'>{since(row.original.created)}</span>,
		}),
		cell.display({
			id: 'actions',
			header: '',
			enableSorting: false,
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Confirm
					title={`Remove ${imageName(row.original)}?`}
					description='An image still used by a container is refused.'
					action='Remove'
					onConfirm={() => remove(row.original.id)}
				>
					<IconButton icon={IconTrash} label='Remove' />
				</Confirm>
			),
		}),
	]
}

export const Route = createFileRoute('/docker/images')({ component: ImagesPage })

function ImagesPage() {
	const queryClient = useQueryClient()

	const images = useQuery({ queryKey: ['images'], queryFn: api.images })

	const remove = useMutation({
		mutationFn: (id: string) => api.removeImage(id, false),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['images'] }),
	})

	const data = images.data ?? []
	const { mutate: removeImage } = remove
	const columns = useMemo(() => imageTableColumns(removeImage), [removeImage])

	return (
		<Page>
			<Section
				title='Local images'
				description={`${data.length} total`}
				actions={<Refresh onClick={() => images.refetch()} busy={images.isFetching} />}
			>
				<ErrorText error={remove.error} />
				<DataTable
					data={data}
					columns={columns}
					loading={images.isLoading}
					getRowId={image => image.id}
					filter='Filter images'
					empty='No images'
				/>
			</Section>
		</Page>
	)
}
