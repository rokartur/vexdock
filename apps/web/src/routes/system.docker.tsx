import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Button, ErrorText, Page, Refresh, Section } from '../components/primitives'
import { api } from '../lib/api'
import { bytes } from '../lib/format'

export const Route = createFileRoute('/system/docker')({ component: CleanupPage })

const targets = [
	{ kind: 'images', label: 'Unused images', field: 'unused_images' },
	{ kind: 'build-cache', label: 'Build cache', field: 'build_cache' },
	{ kind: 'containers', label: 'Stopped containers', field: 'stopped_containers' },
	{ kind: 'volumes', label: 'Unused volumes', field: 'unused_volumes' },
] as const

type CleanupTarget = (typeof targets)[number]
type CleanupRow = { kind: CleanupTarget['kind']; label: string; size: number | undefined }

function cleanupTableColumns(
	confirming: string | null,
	setConfirming: (kind: string | null) => void,
	clean: (kind: CleanupTarget['kind']) => void,
): Columns<CleanupRow> {
	const cell = columnsFor<CleanupRow>()
	return [
		cell.accessor(row => row.label, { id: 'target', header: 'Target' }),
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
			cell: ({ row: { original } }) =>
				confirming === original.kind ? (
					<span className='flex justify-end gap-1.5'>
						<Button variant='danger' onClick={() => clean(original.kind)}>
							confirm
						</Button>
						<Button variant='ghost' onClick={() => setConfirming(null)}>
							cancel
						</Button>
					</span>
				) : (
					<Button variant='ghost' onClick={() => setConfirming(original.kind)}>
						clean
					</Button>
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
	const [confirming, setConfirming] = useState<string | null>(null)
	const [result, setResult] = useState('')

	const preview = useQuery({ queryKey: ['cleanup'], queryFn: api.cleanupPreview })

	const cleanup = useMutation({
		mutationFn: (kind: (typeof targets)[number]['kind']) => api.cleanup(kind),
		onSuccess: async report => {
			setConfirming(null)
			setResult(`Removed ${report.removed} ${report.kind}, reclaimed ${bytes(report.space_reclaimed)}.`)
			await queryClient.invalidateQueries({ queryKey: ['cleanup'] })
		},
	})

	const rows = useMemo<CleanupRow[]>(
		() => targets.map(({ kind, label, field }) => ({ kind, label, size: preview.data?.[field] })),
		[preview.data],
	)
	const { mutate: clean } = cleanup
	const columns = useMemo(() => cleanupTableColumns(confirming, setConfirming, clean), [confirming, clean])

	return (
		<Page title='Docker cleanup'>
			<Section
				title='Reclaimable space'
				description='review before removing anything'
				actions={<Refresh onClick={() => preview.refetch()} busy={preview.isFetching} />}
			>
				<ErrorText error={cleanup.error} />
				{result ? <p className='pb-2 text-body text-emerald-400'>{result}</p> : null}
				<DataTable data={rows} columns={columns} loading={preview.isLoading} getRowId={row => row.kind} />
			</Section>
		</Page>
	)
}
