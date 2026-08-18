import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Page, Refresh, Section } from '../components/primitives'
import { api, type NetworkSummary } from '../lib/api'

function networkTableColumns(): Columns<NetworkSummary> {
	const cell = columnsFor<NetworkSummary>()
	return [
		cell.accessor(network => network.name, { id: 'name', header: 'Name', meta: { mono: true } }),
		cell.accessor(network => network.driver, { id: 'driver', header: 'Driver', meta: { mono: true } }),
		cell.accessor(network => network.scope, { id: 'scope', header: 'Scope', meta: { mono: true } }),
		cell.accessor(network => network.containers?.map(container => container.name).join(', ') || '-', {
			id: 'containers',
			header: 'Connected containers',
			meta: { mono: true },
		}),
	]
}

export const Route = createFileRoute('/docker/networks')({ component: NetworksPage })

function NetworksPage() {
	const networks = useQuery({ queryKey: ['networks'], queryFn: api.networks })

	const data = networks.data ?? []
	const columns = useMemo(networkTableColumns, [])

	return (
		<Page>
			<Section
				title='All networks'
				description={`${data.length} total`}
				actions={<Refresh onClick={() => networks.refetch()} busy={networks.isFetching} />}
			>
				<DataTable
					data={data}
					columns={columns}
					loading={networks.isLoading}
					getRowId={network => network.id}
					empty='No networks.'
				/>
			</Section>
		</Page>
	)
}
