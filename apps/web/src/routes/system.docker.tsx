import { useMemo, useState } from 'react'
import {
	IconBox,
	IconCircleCheck,
	IconDatabase,
	IconStack2,
	IconTrash,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Confirm, ErrorText, IconButton, Page, Refresh, Section } from '../components/primitives'
import { api } from '../lib/api'
import { bytes } from '../lib/format'

export const Route = createFileRoute('/system/docker')({ component: CleanupPage })

const targets = [
	{ kind: 'images', label: 'Unused images', field: 'unused_images', icon: IconStack2 },
	{ kind: 'build-cache', label: 'Build cache', field: 'build_cache', icon: IconStack2 },
	{ kind: 'containers', label: 'Stopped containers', field: 'stopped_containers', icon: IconBox },
	{ kind: 'volumes', label: 'Unused volumes', field: 'unused_volumes', icon: IconDatabase },
] as const

type CleanupTarget = (typeof targets)[number]
type CleanupRow = { kind: CleanupTarget['kind']; label: string; icon: TablerIcon; size: number | undefined }

function cleanupTableColumns(clean: (kind: CleanupTarget['kind']) => void): Columns<CleanupRow> {
	const cell = columnsFor<CleanupRow>()
	return [
		cell.accessor(row => row.label, {
			id: 'target',
			header: 'Target',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2'>
					<row.original.icon className='size-4 text-muted-foreground' />
					{row.original.label}
				</span>
			),
		}),
		cell.accessor(row => row.size ?? 0, {
			id: 'size',
			header: 'Size',
			meta: { mono: true },
			cell: ({ row }) => bytes(row.original.size),
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row: { original } }) => (
				<Confirm
					title={`Remove ${original.label.toLowerCase()}?`}
					description={`Reclaims about ${bytes(original.size)}. Nothing in use is touched.`}
					action='Remove'
					onConfirm={() => clean(original.kind)}
				>
					<IconButton icon={IconTrash} label='Remove' />
				</Confirm>
			),
		}),
	]
}

/**
 * Nothing is pruned automatically. The user sees what each action reclaims and
 * confirms it explicitly.
 */
function CleanupPage() {
	const queryClient = useQueryClient()
	const [result, setResult] = useState('')

	const preview = useQuery({ queryKey: ['cleanup'], queryFn: api.cleanupPreview })

	const cleanup = useMutation({
		mutationFn: (kind: (typeof targets)[number]['kind']) => api.cleanup(kind),
		onSuccess: async report => {
			setResult(`Removed ${report.removed} ${report.kind}, reclaimed ${bytes(report.space_reclaimed)}.`)
			await queryClient.invalidateQueries({ queryKey: ['cleanup'] })
		},
	})

	const rows = useMemo<CleanupRow[]>(
		() => targets.map(({ kind, label, field, icon }) => ({ kind, label, icon, size: preview.data?.[field] })),
		[preview.data],
	)
	const { mutate: clean } = cleanup
	const columns = useMemo(() => cleanupTableColumns(clean), [clean])

	return (
		<Page labels={{ docker: 'Docker cleanup' }}>
			<Section
				title='Reclaimable space'
				description='review before removing anything'
				actions={<Refresh onClick={() => preview.refetch()} busy={preview.isFetching} />}
			>
				<ErrorText error={cleanup.error} />
				{result ? (
					<Alert className='mb-3'>
						<IconCircleCheck className='text-emerald-400' />
						<AlertDescription>{result}</AlertDescription>
					</Alert>
				) : null}
				<DataTable data={rows} columns={columns} loading={preview.isLoading} getRowId={row => row.kind} />
			</Section>
		</Page>
	)
}
