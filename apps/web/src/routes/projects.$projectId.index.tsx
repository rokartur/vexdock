import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { type Columns, DataTable, columnsFor } from '../components/data-table'
import { ImportServicesForm } from '../components/import-services-form'
import { NewServiceForm, newServiceTitle, type ServiceKind } from '../components/new-service-form'
import { Button, Cells, ErrorText, Refresh, Section, Status } from '../components/primitives'
import { api, type Domain, type Service } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { bytes, duration, percent, since } from '../lib/format'

/** The menu, in the order it reads: the two everyday kinds, then the escape hatch. */
const creatable: { kind: ServiceKind; label: string }[] = [
	{ kind: 'application', label: 'Application' },
	{ kind: 'database', label: 'Database' },
	{ kind: 'compose', label: 'Compose' },
]

type RowActions = {
	projectId: string
	hostnames: Map<string, string[]>
	deploy: (serviceId: string) => void
	act: (serviceId: string, action: 'start' | 'restart') => void
}

/**
 * The columns are what you check before opening a service: whether it is up,
 * what it runs, where it answers, what it costs, how long it has been that way.
 * A service whose source is still unanswered says so instead of reading as
 * broken, and the image falls back to what the container was actually started
 * from so a derived service still shows something.
 */
function serviceColumns({ projectId, hostnames, deploy, act }: RowActions): Columns<Service> {
	const cell = columnsFor<Service>()
	return [
		cell.accessor(service => service.compose_service_name, {
			id: 'name',
			header: 'Name',
			cell: ({ row: { original } }) => (
				<span className='flex items-center gap-2'>
					<TypeBadge type={original.type} />
					<Link
						to='/projects/$projectId/services/$serviceId'
						params={{ projectId, serviceId: original.id }}
						className='hover:underline'
					>
						{original.compose_service_name}
					</Link>
				</span>
			),
		}),
		cell.accessor(service => (service.source_type === 'unconfigured' ? '' : service.state || 'stopped'), {
			id: 'state',
			header: 'State',
			cell: ({ row: { original } }) =>
				original.source_type === 'unconfigured' ? (
					<span className='text-muted-foreground'>needs a source</span>
				) : (
					<Status value={original.state || 'stopped'} />
				),
		}),
		cell.accessor(
			service => (service.source_type === 'unconfigured' ? '' : service.image || service.running_image),
			{
				id: 'image',
				header: 'Image',
				meta: { mono: true },
				cell: ({ getValue }) => getValue() || '-',
			},
		),
		cell.accessor(service => hostnames.get(service.id)?.[0] ?? '', {
			id: 'domain',
			header: 'Domain',
			meta: { mono: true },
			cell: ({ row: { original } }) => {
				const [first, ...rest] = hostnames.get(original.id) ?? []
				if (!first) {
					return (
						<span className='text-muted-foreground'>{original.type === 'database' ? 'internal' : '-'}</span>
					)
				}
				return (
					<>
						<a href={`https://${first}`} target='_blank' rel='noreferrer' className='hover:underline'>
							{first}
						</a>
						{rest.length > 0 ? <span className='text-muted-foreground'> +{rest.length}</span> : null}
					</>
				)
			},
		}),
		cell.accessor(service => service.cpu_percent, {
			id: 'cpu',
			header: 'CPU',
			meta: { align: 'right', mono: true },
			cell: ({ row: { original } }) =>
				original.state === 'running' ? (
					percent(original.cpu_percent)
				) : (
					<span className='text-muted-foreground'>-</span>
				),
		}),
		cell.accessor(service => service.memory_usage, {
			id: 'memory',
			header: 'Memory',
			meta: { align: 'right', mono: true },
			cell: ({ row: { original } }) =>
				original.state === 'running' ? (
					bytes(original.memory_usage)
				) : (
					<span className='text-muted-foreground'>-</span>
				),
		}),
		// The container is recreated on every deploy, so when it was created is
		// when this service last shipped.
		cell.accessor(service => service.created_unix, {
			id: 'deployed',
			header: 'Deployed',
			cell: ({ row: { original } }) =>
				original.created_unix ? (
					since(original.created_unix)
				) : (
					<span className='text-muted-foreground'>never</span>
				),
		}),
		cell.display({
			id: 'actions',
			header: '',
			meta: { align: 'right' },
			cell: ({ row: { original } }) => {
				const running = original.state === 'running'
				return (
					<span className='flex justify-end gap-1.5'>
						<Button
							variant='ghost'
							onClick={() => deploy(original.id)}
							disabled={original.source_type === 'unconfigured'}
						>
							deploy
						</Button>
						<Button
							variant='ghost'
							render={
								<Link
									to='/projects/$projectId/services/$serviceId'
									params={{ projectId, serviceId: original.id }}
									search={{ tab: 'logs' }}
								/>
							}
						>
							logs
						</Button>
						<Button variant='ghost' onClick={() => act(original.id, running ? 'restart' : 'start')}>
							{running ? 'restart' : 'start'}
						</Button>
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
		refetchInterval: 5000,
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
			await navigate({ to: '/deployments/$deploymentId', params: { deploymentId: deployment.id } })
		},
	})
	const deployOne = useMutation({
		mutationFn: (serviceId: string) => api.deployService(serviceId),
		onSuccess: deployment =>
			navigate({ to: '/deployments/$deploymentId', params: { deploymentId: deployment.id } }),
	})
	const act = useMutation({
		mutationFn: ({ serviceId, action }: { serviceId: string; action: 'start' | 'restart' }) =>
			api.serviceAction(serviceId, action),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['services', projectId] }),
	})

	const data = services.data ?? []
	const running = data.filter(service => service.state === 'running').length
	const latest = deployments.data?.[0]
	const cpu = data.reduce((total, service) => total + service.cpu_percent, 0)
	const memory = data.reduce((total, service) => total + service.memory_usage, 0)
	const hostnames = useMemo(() => hostnamesByService(domains.data ?? []), [domains.data])
	const { mutate: runDeploy } = deployOne
	const { mutate: runAction } = act
	const columns = useMemo(
		() =>
			serviceColumns({
				projectId,
				hostnames,
				deploy: runDeploy,
				act: (serviceId, action) => runAction({ serviceId, action }),
			}),
		[projectId, hostnames, runDeploy, runAction],
	)

	return (
		<>
			<Cells className='mb-7'>
				<div className='px-3 py-2.5'>
					<div className='text-meta tracking-wide text-muted-foreground uppercase'>Services</div>
					<div className='mt-1 font-mono text-reading tabular-nums'>
						{running} / {data.length}
					</div>
					<div className='mt-0.5 text-meta text-muted-foreground'>running</div>
				</div>
				<div className='px-3 py-2.5'>
					<div className='text-meta tracking-wide text-muted-foreground uppercase'>Last deploy</div>
					<div className='mt-1 text-reading'>
						{latest ? (
							<Link
								to='/deployments/$deploymentId'
								params={{ deploymentId: latest.id }}
								className='font-mono hover:underline'
							>
								#{latest.number}
							</Link>
						) : (
							<span className='text-muted-foreground'>none yet</span>
						)}
					</div>
					<div className='mt-0.5 flex items-center gap-2 text-meta text-muted-foreground'>
						{latest ? (
							<>
								<Status value={latest.status} />
								<span>{since(latest.created_at)}</span>
								<span>{duration(latest.started_at, latest.finished_at)}</span>
							</>
						) : null}
					</div>
				</div>
				<div className='px-3 py-2.5'>
					<div className='text-meta tracking-wide text-muted-foreground uppercase'>Domains</div>
					<div className='mt-1 truncate font-mono text-reading'>
						{domains.data?.[0]?.hostname ?? <span className='text-muted-foreground'>none</span>}
					</div>
					<div className='mt-0.5 text-meta text-muted-foreground'>
						{(domains.data?.length ?? 0) > 1 ? `+${(domains.data?.length ?? 0) - 1} more` : ' '}
					</div>
				</div>
				<div className='px-3 py-2.5'>
					<div className='text-meta tracking-wide text-muted-foreground uppercase'>CPU</div>
					<div className='mt-1 font-mono text-reading tabular-nums'>{percent(cpu)}</div>
					<div className='mt-0.5 text-meta text-muted-foreground'>across its services</div>
				</div>
				<div className='px-3 py-2.5'>
					<div className='text-meta tracking-wide text-muted-foreground uppercase'>Memory</div>
					<div className='mt-1 font-mono text-reading tabular-nums'>{bytes(memory)}</div>
					<div className='mt-0.5 text-meta text-muted-foreground'>across its services</div>
				</div>
			</Cells>

			<Section
				title='Services'
				description={`${data.length} in this environment`}
				actions={
					<>
						{data.length === 0 && !services.isLoading ? (
							<Button onClick={() => deployAll.mutate()} disabled={deployAll.isPending}>
								{deployAll.isPending ? 'Starting…' : 'Deploy all'}
							</Button>
						) : null}
						<Button onClick={() => setCreating('import')}>Import</Button>
						<DropdownMenu>
							<DropdownMenuTrigger render={<Button variant='primary' />}>
								+ New service
							</DropdownMenuTrigger>
							<DropdownMenuContent align='end'>
								{creatable.map(entry => (
									<DropdownMenuItem key={entry.kind} onClick={() => setCreating(entry.kind)}>
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
						) : creating === null ? null : (
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
						)}
					</DialogContent>
				</Dialog>

				<DataTable
					data={data}
					columns={columns}
					loading={services.isLoading}
					getRowId={service => service.id}
					empty='No services yet. Add one, or Deploy all to pick up what the compose file declares.'
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

function TypeBadge({ type }: { type: Service['type'] }) {
	const database = type === 'database'
	return (
		<span
			className={`shrink-0 border px-1.5 py-0.5 font-mono text-label uppercase ${
				database ? 'border-emerald-900 text-emerald-500' : 'border-indigo-900 text-indigo-400'
			}`}
		>
			{database ? 'DB' : 'App'}
		</span>
	)
}
