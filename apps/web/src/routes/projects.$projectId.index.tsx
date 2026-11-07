import { useMemo, useState } from 'react'
import {
	IconBox,
	IconCpu,
	IconDatabase,
	IconDownload,
	IconExternalLink,
	IconFileCode,
	IconPlus,
	IconRocket,
	IconServer,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DropdownMenu } from '@/components/ui/dropdown-menu'
import { AnimatedNumber } from '../components/animated-number'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { ImportServicesForm } from '../components/import-services-form'
import { NewServiceForm, newServiceTitles, type ServiceKind } from '../components/new-service-form'
import {
	Announcement,
	Button,
	Check,
	EmptyState,
	ErrorText,
	Meter,
	PendingReading,
	Refresh,
	RelativeTime,
	Section,
	StatStrip,
	Status,
	textLink,
} from '../components/primitives'
import { BulkMoveDialog, ServiceBulkActions, useServiceBulk } from '../components/service-bulk-actions'
import { api, type Deployment, type Domain, type Service } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { bytes, percent } from '../lib/format'
import { deploymentsQuery, preload, projectDomainsQuery, servicesQuery, systemInfoQuery } from '../lib/queries'

/** What the New service menu opens: the three service kinds, plus the import escape hatch. */
type Creating = ServiceKind | 'import'

const creatable: { kind: Creating; label: string; icon: TablerIcon; separatorBefore?: boolean }[] = [
	{ kind: 'application', label: 'Application', icon: IconBox },
	{ kind: 'database', label: 'Database', icon: IconDatabase },
	{ kind: 'compose', label: 'Compose', icon: IconFileCode },
	{ kind: 'import', label: 'Import from a project', icon: IconDownload, separatorBefore: true },
]

function dialogTitle(creating: Creating | null) {
	if (creating === null || creating === 'import') return 'Import services'
	return newServiceTitles[creating]
}

/** A service row: the service plus the domains the domains query attached to it. */
type ServiceRow = { service: Service; domains: Domain[] }

const none = <span className='text-muted'>-</span>

/**
 * A service whose source is still unanswered says so instead of reading as broken, and the image column falls back
 * to what the container was started from so a derived service still shows something.
 */
function serviceTableColumns(selection: {
	selected: string[]
	/** Docker reads 100% per core, so a busy service on a multi-core host passes 100. */
	cpuCeiling: number
	total: number
	toggle: (id: string) => void
	toggleAll: () => void
}): Columns<ServiceRow> {
	const cell = columnsFor<ServiceRow>()
	return [
		cell.display({
			id: 'select',
			header: () => (
				<Check
					label=''
					name='Select every service'
					checked={selection.selected.length > 0 && selection.selected.length === selection.total}
					indeterminate={selection.selected.length > 0 && selection.selected.length < selection.total}
					onChange={() => selection.toggleAll()}
				/>
			),
			cell: ({ row: { original } }) => (
				<Check
					label=''
					name={`Select ${original.service.compose_service_name}`}
					checked={selection.selected.includes(original.service.id)}
					onChange={() => selection.toggle(original.service.id)}
				/>
			),
		}),
		cell.accessor(({ service }) => service.compose_service_name, {
			id: 'name',
			header: 'Name',
			cell: ({ row: { original } }) => {
				const Icon = original.service.type === 'database' ? IconDatabase : IconBox
				return (
					<Link
						to='/projects/$projectId/services/$serviceId'
						params={{ projectId: original.service.project_id, serviceId: original.service.id }}
						tabIndex={-1}
						className={cn(textLink, 'inline-flex items-center gap-2 font-medium')}
					>
						<Icon stroke={1.75} className='size-4 text-muted' />
						{original.service.compose_service_name}
						<Badge>{original.service.type === 'database' ? 'db' : 'app'}</Badge>
					</Link>
				)
			},
		}),
		cell.accessor(({ service }) => service.state, {
			id: 'state',
			header: 'State',
			cell: ({ row: { original } }) =>
				original.service.provider === 'unconfigured' && original.service.state === '' ? (
					<span className='text-muted'>needs a source</span>
				) : (
					<Status value={original.service.state || 'stopped'} />
				),
		}),
		cell.accessor(
			({ service }) =>
				service.provider === 'unconfigured' ? service.running_image : service.image || service.running_image,
			{
				id: 'image',
				header: 'Image',
				meta: { mono: true },
				cell: ({ getValue }) => getValue() || none,
			},
		),
		cell.accessor(({ domains }) => domains[0]?.hostname ?? '', {
			id: 'domain',
			header: 'Domain',
			cell: ({ row: { original } }) => {
				const [domain, ...more] = original.domains
				if (!domain) {
					return <span className='text-muted'>{original.service.type === 'database' ? 'internal' : '-'}</span>
				}
				return (
					<span className='inline-flex items-center gap-1.5'>
						<a
							href={`${domain.https_enabled ? 'https' : 'http'}://${domain.hostname}`}
							target='_blank'
							rel='noreferrer'
							className={cn(textLink, 'group inline-flex items-center gap-1')}
						>
							{domain.hostname}
							<IconExternalLink
								stroke={1.75}
								className='size-3 text-muted opacity-0 transition-opacity duration-110 ease-standard group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100'
							/>
						</a>
						{more.length > 0 ? (
							<span className='text-muted'>
								+{more.length}
								<span className='sr-only'> more {more.length === 1 ? 'domain' : 'domains'}</span>
							</span>
						) : null}
					</span>
				)
			},
		}),
		cell.accessor(({ service }) => service.cpu_percent, {
			id: 'cpu',
			header: 'CPU',
			cell: ({ row: { original } }) =>
				original.service.state === 'running' ? (
					<Meter
						label={percent(original.service.cpu_percent)}
						value={original.service.cpu_percent}
						max={selection.cpuCeiling}
					/>
				) : (
					none
				),
		}),
		cell.accessor(({ service }) => service.memory_usage, {
			id: 'memory',
			header: 'Memory',
			meta: { align: 'right', mono: true },
			cell: ({ row: { original } }) =>
				original.service.state === 'running' ? bytes(original.service.memory_usage) : none,
		}),
		// The container is recreated on every deploy, so when it was created is
		// when this service last shipped.
		cell.accessor(({ service }) => service.created_unix ?? 0, {
			id: 'deployed',
			header: 'Deployed',
			cell: ({ row: { original } }) =>
				original.service.created_unix ? (
					<RelativeTime at={original.service.created_unix} />
				) : (
					<span className='text-muted'>Never</span>
				),
		}),
	]
}

export const Route = createFileRoute('/projects/$projectId/')({
	loaderDeps: ({ search }) => ({ env: search.env }),
	loader: ({ context: { queryClient }, params: { projectId }, deps: { env } }) =>
		Promise.all([
			preload(queryClient, servicesQuery(projectId, env)),
			preload(queryClient, deploymentsQuery(projectId, env)),
			preload(queryClient, projectDomainsQuery(projectId)),
			preload(queryClient, systemInfoQuery),
		]),
	component: ProjectServices,
})

function ProjectServices() {
	const { projectId } = Route.useParams()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [creating, setCreating] = useState<Creating | null>(null)
	const adding = useIsMutating({ mutationKey: ['add-services', projectId] }) > 0
	const [picked, setPicked] = useState<string[]>([])

	const environmentId = useEnvironmentId()
	const services = useQuery(servicesQuery(projectId, environmentId))
	const deployments = useQuery(deploymentsQuery(projectId, environmentId))
	const domains = useQuery(projectDomainsQuery(projectId))
	const info = useQuery(systemInfoQuery)
	const cpuCeiling = (info.data?.host.cpus ?? 1) * 100

	// One deployment per service, so there is no single log to open; each service's own tab has its own, and the
	// queued count is read out here.
	const [deployed, setDeployed] = useState({ text: '', at: 0 })
	const deployAll = useMutation({
		mutationFn: () => api.deploy(projectId, environmentId),
		onSuccess: async queued => {
			const noun = queued.length === 1 ? 'service' : 'services'
			setDeployed({ text: `Queued a deploy for ${queued.length} ${noun}`, at: Date.now() })
			await queryClient.invalidateQueries({ queryKey: ['services', projectId] })
			await queryClient.invalidateQueries({ queryKey: ['deployments', projectId] })
		},
	})

	const data = useMemo(() => services.data ?? [], [services.data])
	// An environment switch keeps this route mounted; ids from another environment, or a removed service, drop out.
	const selected = useMemo(() => picked.filter(id => data.some(service => service.id === id)), [picked, data])
	const bulk = useServiceBulk({ services: data, selected, onDone: () => setPicked([]) })
	const running = data.filter(service => service.state === 'running').length
	const latest = deployments.data?.[0]
	const latestService = data.find(service => service.compose_service_name === latest?.service_name)
	const cpu = data.reduce((total, service) => total + service.cpu_percent, 0)
	const memory = data.reduce((total, service) => total + service.memory_usage, 0)
	const rows = useMemo<ServiceRow[]>(() => {
		const byService = domainsByService(domains.data ?? [])
		return data.map(service => ({ service, domains: byService.get(service.id) ?? [] }))
	}, [data, domains.data])
	const columns = useMemo(
		() =>
			serviceTableColumns({
				selected,
				cpuCeiling,
				total: data.length,
				toggle: id =>
					setPicked(selected.includes(id) ? selected.filter(other => other !== id) : [...selected, id]),
				toggleAll: () => setPicked(selected.length > 0 ? [] : data.map(service => service.id)),
			}),
		[selected, data, cpuCeiling],
	)

	return (
		<>
			<ErrorText error={deployments.error} />
			{services.data?.length === 0 ? null : (
				<StatStrip
					className='mb-4'
					items={[
						{
							label: 'Running',
							icon: IconBox,
							// The Services section beside it carries the total.
							value: services.data ? (
								running
							) : (
								<PendingReading label='services' failed={services.isError} />
							),
							hint: 'services up',
						},
						{
							label: 'Last deploy',
							icon: IconRocket,
							value: deployments.data ? (
								<LastDeploy projectId={projectId} latest={latest} serviceId={latestService?.id} />
							) : (
								<PendingReading label='the last deploy' failed={deployments.isError} />
							),
							hint: latest ? (
								<span className='flex items-center gap-2'>
									<Status run value={latest.status} />
									<RelativeTime at={latest.created_at} />
								</span>
							) : null,
						},
						{
							label: 'CPU',
							icon: IconCpu,
							value: services.data ? (
								<AnimatedNumber key={projectId} value={cpu} format={percent} />
							) : (
								<PendingReading label='CPU' failed={services.isError} />
							),
							hint: 'across its services',
						},
						{
							label: 'Memory',
							icon: IconServer,
							value: services.data ? (
								<AnimatedNumber key={projectId} value={memory} format={bytes} />
							) : (
								<PendingReading label='memory' failed={services.isError} />
							),
							hint: 'across its services',
						},
					]}
				/>
			)}

			<Section
				title='Services'
				total={services.data?.length}
				actions={
					<>
						<Refresh onClick={() => services.refetch()} />
						{selected.length > 0 || bulk.run.isPending ? <ServiceBulkActions bulk={bulk} /> : null}
						<BulkMoveDialog bulk={bulk} />
						{/* The manager skips a service with no source, so Deploy all needs one that has one. */}
						{data.some(service => service.provider !== 'unconfigured') && (
							<Button size='sm' onClick={() => deployAll.mutate()} loading={deployAll.isPending}>
								<IconRocket size={16} stroke={1.75} />
								Deploy all
							</Button>
						)}
						<DropdownMenu
							trigger={
								<Button variant='primary' size='sm'>
									<IconPlus size={16} stroke={1.75} />
									New service
								</Button>
							}
							items={creatable.map(entry => ({
								label: entry.label,
								icon: <entry.icon size={16} stroke={1.75} />,
								separatorBefore: entry.separatorBefore,
								onSelect: () => setCreating(entry.kind),
							}))}
						/>
					</>
				}
			>
				<ErrorText error={deployAll.error} />
				<ErrorText error={bulk.error} />
				<Announcement message={deployed} />
				<Announcement message={bulk.announced} />
				<ErrorText error={domains.error} />
				{/* Not a FormDialog: each form owns its mutation and footer, and this one dialog swaps between them. Like a
				    FormDialog it stays open while a create or import runs, so the result has somewhere to land. */}
				<Dialog open={creating !== null} onOpenChange={open => !open && !adding && setCreating(null)}>
					<DialogContent title={dialogTitle(creating)} className='[--dialog-width:32rem]'>
						{creating === 'import' ? (
							<ImportServicesForm
								projectId={projectId}
								existingNames={data.map(service => service.compose_service_name)}
								onDone={async () => {
									setCreating(null)
									await queryClient.invalidateQueries({ queryKey: ['services', projectId] })
									await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
									await queryClient.invalidateQueries({ queryKey: ['projects'] })
								}}
								onCancel={() => setCreating(null)}
							/>
						) : null}
						{creating !== null && creating !== 'import' ? (
							<NewServiceForm
								projectId={projectId}
								kind={creating}
								onDone={async service => {
									setCreating(null)
									await queryClient.invalidateQueries({ queryKey: ['services', projectId] })
									await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
									await queryClient.invalidateQueries({ queryKey: ['projects'] })
									await navigate({
										to: '/projects/$projectId/services/$serviceId',
										params: { projectId, serviceId: service.id },
										// The dialog's exit is the motion; a page swap would freeze it in the snapshot.
										viewTransition: false,
									})
								}}
								onCancel={() => setCreating(null)}
							/>
						) : null}
					</DialogContent>
				</Dialog>

				<DataTable
					data={rows}
					columns={columns}
					loading={services.isLoading}
					error={services.error}
					getRowId={({ service }) => service.id}
					onRowClick={({ service }) =>
						navigate({
							to: '/projects/$projectId/services/$serviceId',
							params: { projectId, serviceId: service.id },
						})
					}
					empty={
						<EmptyState
							icon={IconBox}
							title='No services yet'
							description='New service adds one, or imports the services another project exported.'
						/>
					}
				/>
			</Section>
		</>
	)
}

/** The project's newest deployment, linked to its log while the service it deployed still exists. */
function LastDeploy({
	projectId,
	latest,
	serviceId,
}: {
	projectId: string
	latest: Deployment | undefined
	serviceId: string | undefined
}) {
	if (!latest) return <span className='text-muted'>Never</span>
	if (!serviceId) return `#${latest.number}`
	return (
		<Link
			to='/projects/$projectId/services/$serviceId/deployments'
			params={{ projectId, serviceId }}
			search={{ deployment: latest.id }}
			className={textLink}
		>
			#{latest.number}
		</Link>
	)
}

function domainsByService(domains: Domain[]): Map<string, Domain[]> {
	const byService = new Map<string, Domain[]>()
	for (const domain of domains) {
		byService.set(domain.service_id, [...(byService.get(domain.service_id) ?? []), domain])
	}
	return byService
}
