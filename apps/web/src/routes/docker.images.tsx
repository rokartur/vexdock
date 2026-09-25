import { Fragment, useMemo } from 'react'
import { IconStack2, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { columnsFor, DataTable, type Columns } from '../components/data-table'
import {
	Confirm,
	ErrorText,
	IconButton,
	Meter,
	Page,
	Refresh,
	RelativeTime,
	Section,
	StatStrip,
} from '../components/primitives'
import { api, type ImageSummary } from '../lib/api'
import { bytes } from '../lib/format'

function shortId(image: ImageSummary) {
	return image.id.replace('sha256:', '').slice(0, 12)
}

/** `repo:tag`, minding that a registry host may carry a port: `localhost:5000/app`. */
function splitTag(reference: string) {
	const colon = reference.lastIndexOf(':')
	return colon > reference.lastIndexOf('/')
		? { repository: reference.slice(0, colon), tag: reference.slice(colon + 1) }
		: { repository: reference, tag: '<none>' }
}

function imageTags(image: ImageSummary) {
	const tags = image.repo_tags?.map(splitTag) ?? []
	return tags.length > 0 ? tags : [{ repository: '<none>', tag: '<none>' }]
}

function imageName(image: ImageSummary) {
	return image.repo_tags?.join(', ') || shortId(image)
}

function imageTableColumns(remove: (id: string) => void, largest: number): Columns<ImageSummary> {
	const cell = columnsFor<ImageSummary>()
	return [
		cell.accessor(
			image =>
				imageTags(image)
					.map(({ repository }) => repository)
					.join(', '),
			{
				id: 'repository',
				header: 'Repository',
				cell: ({ getValue }) => (
					<span className='inline-flex items-center gap-2'>
						<IconStack2 className='size-4 text-muted-foreground' />
						<span className='font-mono text-label'>{getValue()}</span>
					</span>
				),
			},
		),
		cell.accessor(
			image =>
				imageTags(image)
					.map(({ tag }) => tag)
					.join(', '),
			{
				id: 'tag',
				header: 'Tag',
				cell: ({ row }) => (
					<span className='flex flex-wrap gap-1'>
						{imageTags(row.original).map(({ tag }) => (
							<Badge key={tag} variant='outline'>
								{tag}
							</Badge>
						))}
					</span>
				),
			},
		),
		cell.accessor(shortId, { id: 'image_id', header: 'Image ID', meta: { mono: true } }),
		cell.accessor(image => image.size, {
			id: 'size',
			header: 'Size',
			// Against the biggest image on the host, so the disk hogs stand out down the column.
			cell: ({ row }) => <Meter label={bytes(row.original.size)} value={row.original.size} max={largest} />,
		}),
		cell.accessor(image => image.containers.map(container => container.name).join(', ') || '-', {
			id: 'containers',
			header: 'Containers',
			meta: { mono: true },
			cell: ({ row }) =>
				row.original.containers.length === 0 ? (
					'-'
				) : (
					<span>
						{row.original.containers.map((container, index) => (
							<Fragment key={container.id}>
								{index > 0 ? ', ' : null}
								<Link
									to='/docker/containers'
									search={{ q: container.name }}
									className='underline-offset-2 hover:text-foreground hover:underline'
								>
									{container.name}
								</Link>
							</Fragment>
						))}
					</span>
				),
		}),
		cell.accessor(image => image.created, {
			id: 'created',
			header: 'Created',
			cell: ({ row }) => <RelativeTime at={row.original.created} />,
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
	const largest = Math.max(0, ...data.map(image => image.size))
	const columns = useMemo(() => imageTableColumns(removeImage, largest), [removeImage, largest])

	const unused = data.filter(image => image.containers.length === 0)
	const reclaimable = unused.reduce((total, image) => total + image.size, 0)
	const stats = [
		{ label: 'Images', value: data.length },
		{ label: 'On disk', value: bytes(data.reduce((total, image) => total + image.size, 0)) },
		{ label: 'Unused', value: unused.length },
		{ label: 'Reclaimable', value: bytes(reclaimable) },
		{ label: 'Largest', value: bytes(largest) },
	]

	return (
		<Page>
			{data.length > 0 ? <StatStrip className='mb-4' items={stats} /> : null}
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
					error={images.error}
					getRowId={image => image.id}
					filter='Filter images'
					empty='No images'
				/>
			</Section>
		</Page>
	)
}
