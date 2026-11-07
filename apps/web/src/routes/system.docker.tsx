import { useMemo } from 'react'
import { IconBox, IconDatabase, IconStack2, IconTrash } from '@tabler/icons-react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Alert } from '@/components/ui/alert'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Confirm, ErrorText, IconButton, Meter, Page, Refresh, Section } from '../components/primitives'
import { api } from '../lib/api'
import { bytes } from '../lib/format'
import { preload } from '../lib/queries'

const cleanupQuery = queryOptions({ queryKey: ['cleanup'], queryFn: api.cleanupPreview })

export const Route = createFileRoute('/system/docker')({
	loader: ({ context: { queryClient } }) => preload(queryClient, cleanupQuery),
	component: CleanupPage,
})

const targets = [
	{ kind: 'images', label: 'Unused images', noun: ['image', 'images'], field: 'unused_images', icon: IconStack2 },
	{
		kind: 'build-cache',
		label: 'Build cache',
		noun: ['cache record', 'cache records'],
		field: 'build_cache',
		icon: IconStack2,
	},
	{
		kind: 'containers',
		label: 'Stopped containers',
		noun: ['container', 'containers'],
		field: 'stopped_containers',
		icon: IconBox,
	},
	{
		kind: 'volumes',
		label: 'Anonymous volumes',
		noun: ['volume', 'volumes'],
		field: 'unused_volumes',
		icon: IconDatabase,
	},
] as const

type CleanupTarget = (typeof targets)[number]
type CleanupRow = CleanupTarget & { size: number | undefined }

function cleanupTableColumns(
	clean: (target: CleanupTarget) => void,
	cleaning: CleanupTarget['kind'] | undefined,
	total: number,
): Columns<CleanupRow> {
	const cell = columnsFor<CleanupRow>()
	return [
		cell.accessor(row => row.label, {
			id: 'target',
			header: 'Target',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2'>
					<row.original.icon stroke={1.75} className='size-4 text-muted' />
					{row.original.label}
				</span>
			),
		}),
		cell.accessor(row => row.size ?? 0, {
			id: 'size',
			header: 'Size',
			cell: ({ row }) => <Meter label={bytes(row.original.size)} value={row.original.size ?? 0} max={total} />,
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row: { original } }) => {
				const name = original.label.toLowerCase()
				const volumes = original.kind === 'volumes'
				return (
					<Confirm
						title={`Remove ${name}?`}
						description={
							volumes
								? `Reclaims about ${bytes(original.size)}. Everything stored in them is destroyed. There is no undo.`
								: `Reclaims about ${bytes(original.size)}. Nothing in use is touched.`
						}
						action={`Remove ${name}`}
						type={volumes ? name : undefined}
						onConfirm={() => clean(original)}
					>
						<IconButton
							icon={IconTrash}
							label={`Remove ${name}`}
							loading={cleaning === original.kind}
							disabled={cleaning !== undefined || original.size === undefined}
						/>
					</Confirm>
				)
			},
		}),
	]
}

/**
 * Nothing is pruned automatically. The user sees what each action reclaims and
 * confirms it explicitly.
 */
function CleanupPage() {
	const queryClient = useQueryClient()
	const preview = useQuery(cleanupQuery)

	const cleanup = useMutation({
		mutationFn: (target: CleanupTarget) => api.cleanup(target.kind),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ['cleanup'] })
		},
	})
	// Read from the last run, so a run that fails replaces the success it would otherwise sit beside.
	const result = cleanup.isSuccess
		? `Removed ${cleanup.data.removed.toLocaleString('en-US')} ${cleanup.variables.noun[cleanup.data.removed === 1 ? 0 : 1]}, reclaimed ${bytes(cleanup.data.space_reclaimed)}.`
		: ''

	const rows = useMemo<CleanupRow[]>(
		() => targets.map(target => ({ ...target, size: preview.data?.[target.field] })),
		[preview.data],
	)
	const { mutate: clean } = cleanup
	const cleaning = cleanup.isPending ? cleanup.variables.kind : undefined
	const total = rows.reduce((sum, row) => sum + (row.size ?? 0), 0)
	const columns = useMemo(() => cleanupTableColumns(clean, cleaning, total), [clean, cleaning, total])

	return (
		<Page labels={{ docker: 'Docker cleanup' }}>
			<Section
				title='Reclaimable space'
				total={preview.data ? bytes(total) : undefined}
				actions={<Refresh onClick={() => preview.refetch()} />}
			>
				<ErrorText error={cleanup.error} />
				{result ? <Alert tone='success' title={result} className='mb-3' /> : null}
				<DataTable
					data={rows}
					columns={columns}
					loading={preview.isLoading}
					error={preview.error}
					getRowId={row => row.kind}
				/>
			</Section>
		</Page>
	)
}
