import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Cell, ErrorText, Page, Row, Section, Skeleton, Table } from '../components/primitives'
import { api } from '../lib/api'
import { bytes } from '../lib/format'

export const Route = createFileRoute('/system/docker')({ component: CleanupPage })

const targets = [
	{ kind: 'images', label: 'Unused images', field: 'unused_images' },
	{ kind: 'build-cache', label: 'Build cache', field: 'build_cache' },
	{ kind: 'containers', label: 'Stopped containers', field: 'stopped_containers' },
	{ kind: 'volumes', label: 'Unused volumes', field: 'unused_volumes' },
] as const

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

	return (
		<Page title='Docker cleanup'>
			<Section title='Reclaimable space' description='review before removing anything'>
				<ErrorText error={cleanup.error} />
				{result ? <p className='pb-2 text-[13px] text-emerald-400'>{result}</p> : null}
				{preview.isLoading ? (
					<Skeleton rows={4} />
				) : (
					<Table head={['Target', 'Size', '']}>
						{targets.map(target => (
							<Row key={target.kind}>
								<Cell>{target.label}</Cell>
								<Cell mono>{bytes(preview.data?.[target.field])}</Cell>
								<Cell right>
									{confirming === target.kind ? (
										<span className='flex justify-end gap-1.5'>
											<Button variant='danger' onClick={() => cleanup.mutate(target.kind)}>
												confirm
											</Button>
											<Button variant='ghost' onClick={() => setConfirming(null)}>
												cancel
											</Button>
										</span>
									) : (
										<Button variant='ghost' onClick={() => setConfirming(target.kind)}>
											clean
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
