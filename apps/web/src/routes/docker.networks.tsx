import { Fragment, type ReactNode, useMemo } from 'react'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { Page, Refresh, Section } from '../components/primitives'
import { api, type ContainerSummary, type NetworkSummary } from '../lib/api'
import { composeProjects } from '../lib/environment'
import { containerName } from '../lib/format'
import { containersQuery, preload } from '../lib/queries'

type ComposeProjects = ReturnType<typeof composeProjects>
type ComposeProject = NonNullable<ReturnType<ComposeProjects['get']>>

const DOCKER_DEFAULT_NETWORKS = new Set(['bridge', 'host', 'none'])

type PublishedPort = {
	key: string
	addresses: string[]
	published: number
	target: number
	protocol: string
	container: ContainerSummary
}

type ServiceRef = { name: string; container: string }
type ServiceGroup = { compose: string; label: string; services: ServiceRef[] }

type NetworkRow = {
	network: NetworkSummary
	label: string
	project: ComposeProject | undefined
	builtin: boolean
	groups: ServiceGroup[]
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
				container,
			})
		}
	}
	return [...byKey.values()].sort((a, b) => a.published - b.published)
}

function reach(addresses: string[]): string {
	if (addresses.some(ip => ip === '0.0.0.0' || ip === '::')) return 'Public'
	if (addresses.every(ip => ip === '127.0.0.1' || ip === '::1')) return 'Local only'
	return addresses.join(', ')
}

function serviceName(container: ContainerSummary): string {
	return container.service || containerName(container)
}

function networkRows(
	networks: NetworkSummary[],
	containers: ContainerSummary[],
	projects: ComposeProjects,
): NetworkRow[] {
	const byId = new Map(containers.map(container => [container.id, container]))
	const rows = networks.map(network => {
		// Compose names a project's own network <project>_default.
		const project = network.name.endsWith('_default')
			? projects.get(network.name.slice(0, -'_default'.length))
			: undefined
		return {
			network,
			label: project?.label ?? network.name,
			project,
			builtin: DOCKER_DEFAULT_NETWORKS.has(network.name),
			groups: serviceGroups(network, byId, projects),
		}
	})
	return rows.sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.label.localeCompare(b.label))
}

function serviceGroups(
	network: NetworkSummary,
	byId: Map<string, ContainerSummary>,
	projects: ComposeProjects,
): ServiceGroup[] {
	const groups = new Map<string, ServiceGroup>()
	for (const member of network.containers) {
		const container = byId.get(member.id)
		const compose = container?.project ?? ''
		const service = { name: container ? serviceName(container) : member.name, container: member.name }
		const group = groups.get(compose)
		if (group) {
			group.services.push(service)
			continue
		}
		groups.set(compose, { compose, label: projects.get(compose)?.label ?? compose, services: [service] })
	}
	for (const group of groups.values()) {
		group.services.sort((a, b) => a.name.localeCompare(b.name))
	}
	return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}

function portTableColumns(projects: ComposeProjects): Columns<PublishedPort> {
	const cell = columnsFor<PublishedPort>()
	return [
		cell.accessor(port => `${port.published}/${port.protocol}`, {
			id: 'port',
			header: 'Port',
			meta: { mono: true },
		}),
		cell.accessor(port => port.target, { id: 'target', header: 'Container port', meta: { mono: true } }),
		cell.accessor(port => reach(port.addresses), {
			id: 'reach',
			header: 'Reachable from',
			cell: ({ getValue }) => (
				<span className={getValue() === 'Public' ? 'text-amber-400' : undefined}>{getValue()}</span>
			),
		}),
		cell.accessor(port => serviceName(port.container), {
			id: 'service',
			header: 'Service',
			meta: { mono: true },
			cell: ({ row, getValue }) => (
				<ContainerLink name={containerName(row.original.container)}>{getValue()}</ContainerLink>
			),
		}),
		cell.accessor(port => projects.get(port.container.project)?.label ?? (port.container.project || '-'), {
			id: 'project',
			header: 'Project',
			cell: ({ row, getValue }) => {
				const project = projects.get(row.original.container.project)
				return project ? <ProjectLink project={project} /> : getValue()
			},
		}),
	]
}

function networkTableColumns(): Columns<NetworkRow> {
	const cell = columnsFor<NetworkRow>()
	return [
		cell.accessor(row => row.label, {
			id: 'network',
			header: 'Network',
			cell: ({ row }) => {
				if (row.original.project) return <ProjectLink project={row.original.project} />
				return (
					<span
						className={
							row.original.builtin ? 'font-mono text-label text-muted-foreground' : 'font-mono text-label'
						}
					>
						{row.original.label}
					</span>
				)
			},
		}),
		cell.accessor(row => row.network.subnets.join(', ') || '-', {
			id: 'subnet',
			header: 'Subnet',
			meta: { mono: true },
		}),
		cell.accessor(row => row.network.containers.length, {
			id: 'containers',
			header: 'Containers',
			meta: { mono: true, align: 'right' },
		}),
		cell.accessor(
			row =>
				row.groups
					.map(group => `${group.label} ${group.services.map(service => service.name).join(' ')}`)
					.join(' '),
			{
				id: 'services',
				header: 'Services',
				meta: { mono: true },
				cell: ({ row }) => <Services row={row.original} />,
			},
		),
	]
}

function Services({ row }: { row: NetworkRow }) {
	if (row.groups.length === 0) {
		return <span className='text-muted-foreground'>{row.builtin ? 'Docker default' : '-'}</span>
	}
	return (
		<span className='flex flex-col gap-0.5'>
			{row.groups.map(group => (
				<span key={group.compose}>
					{row.groups.length > 1 && group.label ? (
						<span className='text-muted-foreground'>{group.label} </span>
					) : null}
					{group.services.map((service, index) => (
						<Fragment key={service.container}>
							{index > 0 ? ', ' : null}
							<ContainerLink name={service.container}>{service.name}</ContainerLink>
						</Fragment>
					))}
				</span>
			))}
		</span>
	)
}

function ContainerLink({ name, children }: { name: string; children: ReactNode }) {
	return (
		<Link
			to='/docker/containers'
			search={{ q: name }}
			className='underline-offset-2 hover:text-foreground hover:underline'
		>
			{children}
		</Link>
	)
}

function ProjectLink({ project }: { project: ComposeProject }) {
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
}

const networksQuery = queryOptions({ queryKey: ['networks'], queryFn: api.networks })

export const Route = createFileRoute('/docker/networks')({
	loader: ({ context: { queryClient } }) =>
		Promise.all([preload(queryClient, networksQuery), preload(queryClient, containersQuery)]),
	component: NetworksPage,
})

function NetworksPage() {
	const networks = useQuery(networksQuery)
	const containers = useQuery(containersQuery)
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })

	const byName = useMemo(() => composeProjects(projects.data ?? []), [projects.data])
	const ports = useMemo(() => publishedPorts(containers.data ?? []), [containers.data])
	const rows = useMemo(
		() => networkRows(networks.data ?? [], containers.data ?? [], byName),
		[networks.data, containers.data, byName],
	)
	const portColumns = useMemo(() => portTableColumns(byName), [byName])
	const columns = useMemo(networkTableColumns, [])

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
				title='Networks'
				description={`${rows.length} total`}
				actions={<Refresh onClick={() => networks.refetch()} busy={networks.isFetching} />}
			>
				<DataTable
					data={rows}
					columns={columns}
					loading={networks.isLoading}
					error={networks.error}
					getRowId={row => row.network.id}
					filter='Filter networks'
					empty='No networks'
				/>
			</Section>
		</Page>
	)
}
