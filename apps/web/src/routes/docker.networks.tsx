import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Cell, Page, Row, Section, Skeleton, Table } from '../components/primitives'
import { api } from '../lib/api'

export const Route = createFileRoute('/docker/networks')({ component: NetworksPage })

function NetworksPage() {
	const networks = useQuery({ queryKey: ['networks'], queryFn: api.networks })

	return (
		<Page title='Networks'>
			<Section title='All networks'>
				{networks.isLoading ? (
					<Skeleton rows={4} />
				) : (
					<Table head={['Name', 'Driver', 'Scope', 'Connected containers']}>
						{networks.data?.map(network => (
							<Row key={network.id}>
								<Cell mono>{network.name}</Cell>
								<Cell mono>{network.driver}</Cell>
								<Cell mono>{network.scope}</Cell>
								<Cell mono>
									{network.containers?.length
										? network.containers.map(container => container.name).join(', ')
										: '-'}
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Section>
		</Page>
	)
}
