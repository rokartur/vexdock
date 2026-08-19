import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { columnsFor, DataTable, type Columns } from '../components/data-table'
import { Button, ErrorText, Page, Refresh, Section } from '../components/primitives'
import { api, type ImageSummary } from '../lib/api'
import { bytes, since } from '../lib/format'

function imageName(image: ImageSummary) {
	return image.repo_tags?.join(', ') || image.id.replace('sha256:', '').slice(0, 12)
}

function imageTableColumns(remove: (id: string) => void): Columns<ImageSummary> {
	const cell = columnsFor<ImageSummary>()
	return [
		cell.accessor(imageName, { id: 'repository', header: 'Repository', meta: { mono: true } }),
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
			cell: ({ row }) => since(row.original.created),
		}),
		cell.display({
			id: 'actions',
			header: '',
			enableSorting: false,
			meta: { align: 'right' },
			cell: ({ row }) => (
				<Button variant='ghost' onClick={() => remove(row.original.id)}>
					remove
				</Button>
			),
		}),
	]
}

export const Route = createFileRoute('/docker/images')({ component: ImagesPage })

function ImagesPage() {
	const queryClient = useQueryClient()
	const [reference, setReference] = useState('')

	const images = useQuery({ queryKey: ['images'], queryFn: api.images })

	const pull = useMutation({
		mutationFn: () => api.pullImage(reference),
		onSuccess: async () => {
			setReference('')
			await queryClient.invalidateQueries({ queryKey: ['images'] })
		},
	})

	const remove = useMutation({
		mutationFn: (id: string) => api.removeImage(id, false),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['images'] }),
	})

	const data = images.data ?? []
	const { mutate: removeImage } = remove
	const columns = useMemo(() => imageTableColumns(removeImage), [removeImage])

	return (
		<Page>
			<Section title='Pull image'>
				<form
					className='flex gap-2 border-t border-border pt-3'
					onSubmit={event => {
						event.preventDefault()
						pull.mutate()
					}}
				>
					<input
						required
						value={reference}
						placeholder='ghcr.io/user/app:latest'
						onChange={event => setReference(event.target.value)}
						className='max-w-md font-mono text-body'
					/>
					<Button type='submit' variant='primary' disabled={pull.isPending}>
						{pull.isPending ? 'Pulling…' : 'Pull'}
					</Button>
				</form>
				<ErrorText error={pull.error} />
			</Section>

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
					empty='No images.'
				/>
			</Section>
		</Page>
	)
}
