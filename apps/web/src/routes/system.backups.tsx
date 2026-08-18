import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Cell, Empty, ErrorText, Page, Row, Section, Skeleton, Table } from '../components/primitives'
import { api } from '../lib/api'
import { bytes, since } from '../lib/format'

export const Route = createFileRoute('/system/backups')({ component: BackupsPage })

function BackupsPage() {
	const queryClient = useQueryClient()
	const backups = useQuery({ queryKey: ['backups'], queryFn: api.backups })

	const create = useMutation({
		mutationFn: (includeVolumes: boolean) => api.createBackup(includeVolumes),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
	})

	return (
		<Page title='Backups'>
			<Section
				title='Snapshots'
				description='database, proxy config and certificates, optionally with application volumes'
				actions={
					<div className='flex items-center gap-2'>
						<Button onClick={() => create.mutate(false)} disabled={create.isPending}>
							Platform only
						</Button>
						<Button variant='primary' onClick={() => create.mutate(true)} disabled={create.isPending}>
							{create.isPending ? 'Creating…' : 'Include volumes'}
						</Button>
						<Refresh onClick={() => backups.refetch()} busy={backups.isFetching} />
					</div>
				}
			>
				<ErrorText error={create.error} />
				{backups.isLoading ? (
					<Skeleton rows={3} />
				) : backups.data?.length === 0 ? (
					<Empty>No backups yet. One is taken automatically before every platform update.</Empty>
				) : (
					<Table head={['Name', 'Size', 'Created', 'Path']}>
						{backups.data?.map(backup => (
							<Row key={backup.name}>
								<Cell mono>{backup.name}</Cell>
								<Cell mono>{bytes(backup.size_bytes)}</Cell>
								<Cell>{since(backup.created_at)}</Cell>
								<Cell mono>{backup.path}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Section>
		</Page>
	)
}
