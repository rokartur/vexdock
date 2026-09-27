import { Fragment, useMemo } from 'react'
import { IconAffiliate, IconPlug } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Page, Refresh, Section } from '../components/primitives'
import { api, type ContainerSummary, type NetworkSummary } from '../lib/api'
import { composeProjects } from '../lib/environment'
import { containerName } from '../lib/format'

type PublishedPort = {
	key: string
	addresses: string[]
	published: number
	target: number
	protocol: string
	container: string
	project: string
}

/** One row per container port; Docker reports it once for 0.0.0.0 and again for ::. */
function publishedPorts(containers: ContainerSummary[]): PublishedPort[] {
	const byKey = new Map<string, PublishedPort>()
	for (const container of containers) {
		for (const port of container.ports) {
			const key = `${container.id}/${port.published}/${port.protocol}`
			const seen = byKey.get(key)
			if (seen) {
				seen.addresses.push(port.ip)
				continue
			}
			byKey.set(key, {
				key,
				addresses: [port.ip],
				published: port.published,
				target: port.target,
				protocol: port.protocol,
				container: containerName(container),
				project: container.project,
			})
		}
	}
	return [...byKey.values()].sort((a, b) => a.published - b.published)
}

function portTableColumns(projects: ReturnType<typeof composeProjects>): Columns<PublishedPort> {
	const cell = columnsFor<PublishedPort>()
	return [
		cell.accessor(port => `${port.published}/${port.protocol}`, {
			id: 'port',
			header: 'Port',
			cell: ({ getValue }) => (
				<span className='inline-flex items-center gap-2'>
					<IconPlug className='size-4 text-muted-foreground' />
					<span className='font-mono text-label'>{getValue()}</span>
				</span>
			),
		}),
		cell.accessor(port => port.addresses.join(', '), { id: 'address', header: 'Listens on', meta: { mono: true } }),
		cell.accessor(port => port.target, { id: 'target', header: 'Container port', meta: { mono: true } }),
		cell.accessor(port => port.container, {
			id: 'container',
			header: 'Container',
			meta: { mono: true },
			cell: ({ getValue }) => (
				<Link
					to='/docker/containers'
					search={{ q: getValue() }}
					className='underline-offset-2 hover:text-foreground hover:underline'
				>
					{getValue()}
				</Link>
			),
		}),
		cell.accessor(port => projects.get(port.project)?.label ?? (port.project || '-'), {
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
	]
}

/** Usable IPv4 hosts across a network's subnets; null when it has none (IPv6-only or unconfigured). */
function usableHosts(subnets: string[]): number | null {
	let total = 0
	for (const subnet of subnets) {
		const [address, prefix] = subnet.split('/')
		if (!(address?.includes('.') && prefix)) continue
		total += 2 ** (32 - Number(prefix)) - 2
	}
	return total > 0 ? total : null
}

function networkTableColumns(): Columns<NetworkSummary> {
	const cell = columnsFor<NetworkSummary>()
	return [
		cell.accessor(network => network.name, {
			id: 'name',
			header: 'Name',
			cell: ({ row }) => (
				<span className='inline-flex items-center gap-2'>
					<IconAffiliate className='size-4 text-muted-foreground' />
					<span className='font-mono text-label'>{row.original.name}</span>
				</span>
			),
		}),
		cell.accessor(network => network.driver, { id: 'driver', header: 'Driver', meta: { mono: true } }),
		cell.accessor(network => network.scope, { id: 'scope', header: 'Scope', meta: { mono: true } }),
		cell.accessor(network => network.subnets.join(', ') || '-', {
			id: 'subnet',
			header: 'Subnet',
			meta: { mono: true },
		}),
		cell.accessor(
			network => {
				const capacity = usableHosts(network.subnets)
				return capacity === null
					? String(network.containers.length)
					: `${network.containers.length} / ${capacity}`
			},
			{ id: 'ips', header: 'IPs in use', meta: { mono: true, align: 'right' } },
		),
		cell.accessor(network => network.containers.map(container => container.name).join(', ') || '-', {
			id: 'containers',
			header: 'Connected containers',
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
	]
}

export const Route = createFileRoute('/docker/networks')({ component: NetworksPage })

function NetworksPage() {
	const networks = useQuery({ queryKey: ['networks'], queryFn: api.networks })
	const containers = useQuery({ queryKey: ['containers'], queryFn: api.containers })
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })

	const data = networks.data ?? []
	const columns = useMemo(networkTableColumns, [])
	const ports = useMemo(() => publishedPorts(containers.data ?? []), [containers.data])
	const portColumns = useMemo(() => portTableColumns(composeProjects(projects.data ?? [])), [projects.data])

	return (
		<Page>
			<Section
				title='Published ports'
				description={`${ports.length} total`}
				actions={<Refresh onClick={() => containers.refetch()} busy={containers.isFetching} />}
			>
				<DataTable
					data={ports}
					columns={portColumns}
					loading={containers.isLoading}
					error={containers.error}
					getRowId={port => port.key}
					filter='Filter ports'
					empty='No published ports'
				/>
			</Section>
			<Section
				title='All networks'
				description={`${data.length} total`}
				actions={<Refresh onClick={() => networks.refetch()} busy={networks.isFetching} />}
			>
				<DataTable
					data={data}
					columns={columns}
					loading={networks.isLoading}
					error={networks.error}
					getRowId={network => network.id}
					filter='Filter networks'
					empty='No networks'
				/>
			</Section>
		</Page>
	)
}
