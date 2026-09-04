import { useMemo, useState } from 'react'
import {
	IconBox,
	IconCpu,
	IconDatabase,
	IconDownload,
	IconExternalLink,
	IconFileCode,
	IconFileText,
	IconPlayerPlay,
	IconPlus,
	IconRefresh,
	IconRocket,
	IconServer,
	IconWorld,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { ImportServicesForm } from '../components/import-services-form'
import { NewServiceForm, newServiceTitle, type ServiceKind } from '../components/new-service-form'
import {
	Button,
	Cell,
	Cells,
	EmptyState,
	ErrorText,
	IconButton,
	Refresh,
	Section,
	Status,
} from '../components/primitives'
import { api, type Domain, type Service } from '../lib/api'
import { deploymentLink } from '../lib/deployment-link'
import { useEnvironmentId } from '../lib/environment'
import { bytes, duration, percent, since } from '../lib/format'

/** The menu, in the order it reads: the two everyday kinds, then the escape hatch. */
const creatable: { kind: ServiceKind; label: string; icon: TablerIcon }[] = [
	{ kind: 'application', label: 'Application', icon: IconBox },
	{ kind: 'database', label: 'Database', icon: IconDatabase },
	{ kind: 'compose', label: 'Compose', icon: IconFileCode },
]

/** A service row: the service plus the hostnames the domains query attached to it. */
type ServiceRow = { service: Service; hostnames: string[] }

type ServiceActions = {
	projectId: string
	deploy: (serviceId: string) => void
	act: (serviceId: string, action: 'start' | 'restart') => void
}

/**
 * One service per row with the facts you check before opening it: whether it
 * is up, what it runs, where it answers, what it costs, how long it has been
 * that way. A service whose source is still unanswered says so instead of
 * reading as broken, and the image falls back to what the container was
 * actually started from so a derived service still shows something.
 */
function serviceTableColumns({ projectId, deploy, act }: ServiceActions): Columns<ServiceRow> {
	const cell = columnsFor<ServiceRow>()
	return [
		cell.accessor(({ service }) => service.compose_service_name, {
			id: 'name',
			header: 'Name',
			cell: ({ row: { original } }) => {
				const Icon = original.service.type === 'database' ? IconDatabase : IconBox
				return (
					<Link
						to='/projects/$projectId/services/$serviceId'
						params={{ projectId, serviceId: original.service.id }}
						className='inline-flex items-center gap-2 font-medium underline-offset-4 hover:underline'
					>
						<Icon className='size-4 text-muted-foreground' />
						{original.service.compose_service_name}
						<Badge variant='outline'>{original.service.type === 'database' ? 'db' : 'app'}</Badge>
					</Link>
				)
			},
		}),
		cell.accessor(({ service }) => service.state, {
			id: 'state',
			header: 'State',
			cell: ({ row: { original } }) =>
				original.service.provider === 'unconfigured' ? (
					<span className='text-muted-foreground'>needs a provider</span>
				) : (
					<Status value={original.service.state || 'stopped'} />
				),
		}),
		cell.accessor(({ service }) => service.image || service.running_image, {
			id: 'image',
			header: 'Image',
			meta: { mono: true },
			cell: ({ row: { original } }) =>
				original.service.provider === 'unconfigured'
					? '-'
					: original.service.image || original.service.running_image || '-',
		}),
		cell.accessor(({ hostnames }) => hostnames[0] ?? '', {
			id: 'domain',
			header: 'Domain',
			cell: ({ row: { original } }) => {
				const [hostname, ...more] = original.hostnames
				if (!hostname) {
					return (
						<span className='text-muted-foreground'>
							{original.service.type === 'database' ? 'internal' : '-'}
						</span>
					)
				}
				return (
					<span className='inline-flex items-center gap-1.5'>
						<a
							href={`https://${hostname}`}
							target='_blank'
							rel='noreferrer'
							className='group inline-flex items-center gap-1 underline-offset-4 hover:underline'
						>
							{hostname}
							<IconExternalLink className='size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100' />
						</a>
						{more.length > 0 ? <span className='text-muted-foreground'>+{more.length}</span> : null}
					</span>
				)
			},
		}),
		cell.accessor(({ service }) => service.cpu_percent, {
			id: 'cpu',
			header: 'CPU',
			meta: { align: 'right', mono: true },
			cell: ({ row: { original } }) =>
				original.service.state === 'running' ? percent(original.service.cpu_percent) : '-',
		}),
		cell.accessor(({ service }) => service.memory_usage, {
			id: 'memory',
			header: 'Memory',
			meta: { align: 'right', mono: true },
			cell: ({ row: { original } }) =>
				original.service.state === 'running' ? bytes(original.service.memory_usage) : '-',
		}),
		// The container is recreated on every deploy, so when it was created is
		// when this service last shipped.
		cell.accessor(({ service }) => service.created_unix ?? 0, {
			id: 'deployed',
			header: 'Deployed',
			cell: ({ row: { original } }) => (
				<span className='text-muted-foreground'>
					{original.service.created_unix ? since(original.service.created_unix) : 'never'}
				</span>
			),
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row: { original } }) => {
				const { service } = original
				const running = service.state === 'running'
				const params = { projectId, serviceId: service.id }
				return (
					<span className='flex justify-end gap-0.5'>
						<IconButton
							icon={IconRocket}
							label='Deploy'
							onClick={() => deploy(service.id)}
							disabled={service.provider === 'unconfigured'}
						/>
						<IconButton
							icon={IconFileText}
							label='Logs'
							render={<Link to='/projects/$projectId/services/$serviceId/logs' params={params} />}
						/>
						<IconButton
							icon={running ? IconRefresh : IconPlayerPlay}
							label={running ? 'Restart' : 'Start'}
							onClick={() => act(service.id, running ? 'restart' : 'start')}
						/>
					</span>
				)
			},
		}),
	]
}

export const Route = createFileRoute('/projects/$projectId/')({ component: ProjectServices })

function ProjectServices() {
	const { projectId } = Route.useParams()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [creating, setCreating] = useState<ServiceKind | 'import' | null>(null)

	const environmentId = useEnvironmentId()
	const services = useQuery({
		queryKey: ['services', projectId, environmentId],
		queryFn: () => api.services(projectId, environmentId),
	})
	const deployments = useQuery({
		queryKey: ['deployments', projectId, environmentId],
		queryFn: () => api.deployments(projectId, environmentId),
	})
	const domains = useQuery({ queryKey: ['domains', projectId], queryFn: () => api.projectDomains(projectId) })

	// Whole-project deploy is the first-run path: it picks up what the compose
	// file declares before any service exists. Day-to-day deploy/stop live on
	// each service, so once there are services the button goes away.
	const deployAll = useMutation({
		mutationFn: () => api.deploy(projectId, environmentId),
		onSuccess: async deployment => {
			await queryClient.invalidateQueries({ queryKey: ['services', projectId] })
			await navigate(deploymentLink(projectId, deployment.id))
		},
	})
	const deployOne = useMutation({
		mutationFn: (serviceId: string) => api.deployService(serviceId),
		onSuccess: deployment => navigate(deploymentLink(projectId, deployment.id)),
	})
	const act = useMutation({
		mutationFn: ({ serviceId, action }: { serviceId: string; action: 'start' | 'restart' }) =>
			api.serviceAction(serviceId, action),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['services', projectId] }),
	})

	const data = useMemo(() => services.data ?? [], [services.data])
	const running = data.filter(service => service.state === 'running').length
	const latest = deployments.data?.[0]
	const cpu = data.reduce((total, service) => total + service.cpu_percent, 0)
	const memory = data.reduce((total, service) => total + service.memory_usage, 0)
	const rows = useMemo<ServiceRow[]>(() => {
		const hostnames = hostnamesByService(domains.data ?? [])
		return data.map(service => ({ service, hostnames: hostnames.get(service.id) ?? [] }))
	}, [data, domains.data])
	const { mutate: deployService } = deployOne
	const { mutate: runAction } = act
	const columns = useMemo(
		() =>
			serviceTableColumns({
				projectId,
				deploy: deployService,
				act: (serviceId, action) => runAction({ serviceId, action }),
			}),
		[projectId, deployService, runAction],
	)
	const empty = data.length === 0 && !services.isLoading

	return (
		<>
			<Cells className='mb-8'>
				<Cell label='Services' icon={IconServer} value={`${running} / ${data.length}`} hint='running' />
				<Cell
					label='Last deploy'
					icon={IconRocket}
					value={
						latest ? (
							<Link
								{...deploymentLink(projectId, latest.id)}
								className='underline-offset-4 hover:underline'
							>
								#{latest.number}
							</Link>
						) : (
							<span className='text-muted-foreground'>none yet</span>
						)
					}
					hint={
						latest ? (
							<span className='flex items-center gap-2'>
								<Status value={latest.status} />
								<span>{since(latest.created_at)}</span>
								<span>{duration(latest.started_at, latest.finished_at)}</span>
							</span>
						) : null
					}
				/>
				<Cell
					label='Domains'
					icon={IconWorld}
					value={domains.data?.[0]?.hostname ?? <span className='text-muted-foreground'>none</span>}
					hint={(domains.data?.length ?? 0) > 1 ? `+${(domains.data?.length ?? 0) - 1} more` : null}
				/>
				<Cell label='CPU' icon={IconCpu} value={percent(cpu)} hint='across its services' />
				<Cell label='Memory' icon={IconServer} value={bytes(memory)} hint='across its services' />
			</Cells>

			<Section
				title='Services'
				description={`${data.length} in this environment`}
				actions={
					<>
						{empty ? (
							<Button onClick={() => deployAll.mutate()} disabled={deployAll.isPending}>
								<IconRocket />
								{deployAll.isPending ? 'Starting…' : 'Deploy all'}
							</Button>
						) : null}
						<Button onClick={() => setCreating('import')}>
							<IconDownload />
							Import
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger render={<Button variant='primary' />}>
								<IconPlus />
								New service
							</DropdownMenuTrigger>
							<DropdownMenuContent align='end'>
								{creatable.map(entry => (
									<DropdownMenuItem key={entry.kind} onClick={() => setCreating(entry.kind)}>
										<entry.icon />
										{entry.label}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
						<Refresh onClick={() => services.refetch()} busy={services.isFetching} />
					</>
				}
			>
				<ErrorText error={deployAll.error ?? deployOne.error ?? act.error} />
				<Dialog open={creating !== null} onOpenChange={open => !open && setCreating(null)}>
					<DialogContent className='sm:max-w-lg'>
						<DialogHeader>
							<DialogTitle>
								{creating === null || creating === 'import'
									? 'Import services'
									: newServiceTitle(creating)}
							</DialogTitle>
						</DialogHeader>
						{creating === 'import' ? (
							<ImportServicesForm
								projectId={projectId}
								existingNames={data.map(service => service.compose_service_name)}
								onDone={async () => {
									setCreating(null)
									await queryClient.invalidateQueries({ queryKey: ['services', projectId] })
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
									await navigate({
										to: '/projects/$projectId/services/$serviceId',
										params: { projectId, serviceId: service.id },
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
					getRowId={({ service }) => service.id}
					empty={
						<EmptyState
							icon={IconBox}
							title='No services yet'
							description='Add one, or Deploy all to pick up what the compose file declares.'
						/>
					}
				/>
			</Section>
		</>
	)
}

function hostnamesByService(domains: Domain[]): Map<string, string[]> {
	const byService = new Map<string, string[]>()
	for (const domain of domains) {
		byService.set(domain.service_id, [...(byService.get(domain.service_id) ?? []), domain.hostname])
	}
	return byService
}
