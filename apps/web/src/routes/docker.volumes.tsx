import { useMemo } from 'react'
import { IconDatabase, IconTrash } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import {
	Confirm,
	ErrorText,
	IconButton,
	Page,
	Refresh,
	RelativeTime,
	Section,
	StatStrip,
} from '../components/primitives'
import { api, type VolumeSummary } from '../lib/api'
import { composeProjects } from '../lib/environment'
import { bytes } from '../lib/format'

function volumeTableColumns(
	remove: (name: string) => void,
	projects: ReturnType<typeof composeProjects>,
): Columns<VolumeSummary> {
	const cell = columnsFor<VolumeSummary>()
	return [
		cell.accessor(volume => volume.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2' title={row.original.name}>
					<IconDatabase className='size-4 text-muted-foreground' />
					<span className='font-mono text-label'>{shortName(row.original)}</span>
				</span>
			),
		}),
		cell.accessor(volume => projectName(volume, projects), {
			id: 'project',
			header: 'Project',
			cell: ({ row, getValue }) => {
				const project = projects.get(row.original.project)
				if (!project) {
					return getValue()
				}
				return (
					<Link
						to='/projects/$projectId'
						params={{ projectId: project.projectId }}
						search={{ env: project.environmentId }}
						className='underline-offset-2 hover:underline'
					>
						{project.label}
					</Link>
				)
			},
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
			cell: ({ row }) => <RelativeTime at={row.original.created_at} />,
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

// Docker names a volume nobody named (an image's VOLUME) with 64 hex characters, like a container id.
const isAnonymous = (volume: VolumeSummary) => /^[0-9a-f]{64}$/.test(volume.name)

// Compose names a volume <compose project>_<key>; the project has its own column.
function shortName(volume: VolumeSummary) {
	if (isAnonymous(volume)) {
		return volume.name.slice(0, 12)
	}
	const prefix = `${volume.project}_`
	return volume.project && volume.name.startsWith(prefix) ? volume.name.slice(prefix.length) : volume.name
}

function projectName(volume: VolumeSummary, projects: ReturnType<typeof composeProjects>) {
	if (volume.project) {
		return projects.get(volume.project)?.label ?? volume.project
	}
	return isAnonymous(volume) ? 'anonymous' : '-'
}

export const Route = createFileRoute('/docker/volumes')({ component: VolumesPage })

function VolumesPage() {
	const queryClient = useQueryClient()

	const volumes = useQuery({ queryKey: ['volumes'], queryFn: api.volumes })
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })

	const remove = useMutation({
		mutationFn: api.removeVolume,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['volumes'] }),
	})

	const data = volumes.data ?? []
	const { mutate: removeVolume } = remove
	const columns = useMemo(
		() => volumeTableColumns(removeVolume, composeProjects(projects.data ?? [])),
		[removeVolume, projects.data],
	)

	// A daemon that cannot count a volume's users or measure it answers -1, which is not zero.
	const counted = data.filter(volume => volume.ref_count >= 0)
	const measured = data.filter(volume => volume.size >= 0)
	const stats = [
		{ label: 'Volumes', value: data.length },
		...(counted.length > 0
			? [{ label: 'Unused', value: counted.filter(volume => volume.ref_count === 0).length }]
			: []),
		...(measured.length > 0
			? [{ label: 'On disk', value: bytes(measured.reduce((total, volume) => total + volume.size, 0)) }]
			: []),
	]

	return (
		<Page>
			{stats.length > 1 ? <StatStrip className='mb-4' items={stats} /> : null}
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
					error={volumes.error}
					getRowId={volume => volume.name}
					filter='Filter volumes'
					empty='No volumes'
				/>
			</Section>
		</Page>
	)
}
