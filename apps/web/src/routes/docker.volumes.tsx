import { useMemo } from 'react'
import { IconDatabase, IconFolder, IconTrash } from '@tabler/icons-react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { cn } from 'cn'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import {
	Button,
	Confirm,
	EmptyState,
	ErrorText,
	IconButton,
	Page,
	Refresh,
	RelativeTime,
	Section,
	StatStrip,
	textLink,
} from '../components/primitives'
import { api, type VolumeSummary } from '../lib/api'
import { composeProjects } from '../lib/environment'
import { bytes } from '../lib/format'
import { preload, projectsQuery } from '../lib/queries'

function volumeTableColumns(
	remove: (name: string) => void,
	removing: string | undefined,
	projects: ReturnType<typeof composeProjects>,
): Columns<VolumeSummary> {
	const cell = columnsFor<VolumeSummary>()
	return [
		cell.accessor(volume => volume.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2' title={row.original.name}>
					<IconDatabase stroke={1.75} className='size-4 text-muted' />
					{/* An anonymous name is 64 hex characters, printed whole and wrapped so it can be read and selected. */}
					<span
						className={cn(
							'font-mono text-xs',
							isAnonymous(row.original) && 'max-w-72 wrap-anywhere whitespace-normal',
						)}
					>
						{isAnonymous(row.original) ? row.original.name : shortName(row.original)}
					</span>
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
						className={textLink}
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
			cell: ({ row }) => bytes(row.original.size),
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
			// Docker refuses a volume any container references, stopped ones included; In use names the count.
			cell: ({ row }) =>
				row.original.ref_count > 0 ? null : (
					<Confirm
						title={`Delete ${row.original.name}?`}
						description='Everything stored in the volume is destroyed. There is no undo.'
						action='Delete volume'
						type={shortName(row.original)}
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

// Docker names a volume nobody named (an image's VOLUME) with 64 hex characters, like a container id.
const isAnonymous = (volume: VolumeSummary) => /^[0-9a-f]{64}$/u.test(volume.name)

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
	return isAnonymous(volume) ? 'Anonymous' : '-'
}

const volumesQuery = queryOptions({ queryKey: ['volumes'], queryFn: api.volumes })

export const Route = createFileRoute('/docker/volumes')({
	loader: ({ context: { queryClient } }) =>
		Promise.all([preload(queryClient, volumesQuery), preload(queryClient, projectsQuery)]),
	component: VolumesPage,
})

function VolumesPage() {
	const queryClient = useQueryClient()

	const volumes = useQuery(volumesQuery)
	const projects = useQuery(projectsQuery)

	const remove = useMutation({
		mutationFn: api.removeVolume,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['volumes'] }),
	})

	const data = volumes.data ?? []
	const { mutate: removeVolume } = remove
	const removing = remove.isPending ? remove.variables : undefined
	const columns = useMemo(
		() => volumeTableColumns(removeVolume, removing, composeProjects(projects.data ?? [])),
		[removeVolume, removing, projects.data],
	)

	// A daemon that cannot count a volume's users or measure it answers -1, which is not zero.
	const counted = data.filter(volume => volume.ref_count >= 0)
	const measured = data.filter(volume => volume.size >= 0)
	// The All volumes section carries the count.
	const stats = [
		...(counted.length > 0
			? [{ label: 'Unused', value: counted.filter(volume => volume.ref_count === 0).length }]
			: []),
		...(measured.length > 0
			? [{ label: 'On disk', value: bytes(measured.reduce((total, volume) => total + volume.size, 0)) }]
			: []),
	]

	return (
		<Page fill>
			{stats.length > 0 ? <StatStrip className='mb-4' items={stats} /> : null}
			<Section
				title='All volumes'
				total={volumes.data?.length}
				fill
				actions={<Refresh onClick={() => volumes.refetch()} />}
			>
				<ErrorText error={remove.error} />
				<ErrorText error={projects.error} />
				<DataTable
					data={data}
					columns={columns}
					loading={volumes.isLoading}
					error={volumes.error}
					getRowId={volume => volume.name}
					filter='Filter volumes'
					empty={
						<EmptyState
							title='No volumes'
							description='A service whose compose file declares a named volume creates one when it deploys.'
						>
							<Button render={<Link to='/projects' />}>
								<IconFolder size={16} stroke={1.75} />
								Open projects
							</Button>
						</EmptyState>
					}
				/>
			</Section>
		</Page>
	)
}
