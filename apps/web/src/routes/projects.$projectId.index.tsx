import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ImportServicesForm } from '../components/import-services-form'
import { NewServiceForm, newServiceTitle, type ServiceKind } from '../components/new-service-form'
import { Button, ErrorText, Refresh, Section, Status } from '../components/primitives'
import { api, type Service } from '../lib/api'

/** The menu, in the order it reads: the two everyday kinds, then the escape
 * hatch, then the one that brings a whole project's worth in at once. */
const creatable: { kind: ServiceKind | 'import'; label: string }[] = [
	{ kind: 'application', label: 'Application' },
	{ kind: 'database', label: 'Database' },
	{ kind: 'compose', label: 'Compose' },
	{ kind: 'import', label: 'Import' },
]

export const Route = createFileRoute('/projects/$projectId/')({ component: ProjectServices })

function ProjectServices() {
	const { projectId } = Route.useParams()
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const [creating, setCreating] = useState<ServiceKind | 'import' | null>(null)

	const services = useQuery({
		queryKey: ['services', projectId],
		queryFn: () => api.services(projectId),
		refetchInterval: 5000,
	})

	// Whole-project deploy stays for first discovery and rare full-stack runs.
	// Day-to-day deploy/stop live on each service.
	const deployAll = useMutation({
		mutationFn: () => api.deploy(projectId),
		onSuccess: async deployment => {
			await queryClient.invalidateQueries({ queryKey: ['services', projectId] })
			await navigate({ to: '/deployments/$deploymentId', params: { deploymentId: deployment.id } })
		},
	})

	const data = services.data ?? []

	return (
		<Section
			title='Services'
			description={`${data.length} in this project`}
			actions={
				<>
					<Button onClick={() => deployAll.mutate()} disabled={deployAll.isPending}>
						{deployAll.isPending ? 'Starting…' : 'Deploy all'}
					</Button>
					<Refresh onClick={() => services.refetch()} busy={services.isFetching} />
				</>
			}
		>
			<ErrorText error={deployAll.error} />
			<Dialog open={creating !== null} onOpenChange={open => !open && setCreating(null)}>
				<DialogContent className='sm:max-w-lg'>
					<DialogHeader>
						<DialogTitle>
							{creating === null || creating === 'import' ? 'Import services' : newServiceTitle(creating)}
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

			<ul className='mb-3 flex flex-col gap-2'>
				{data.map(service => (
					<ServiceRow key={service.id} projectId={projectId} service={service} />
				))}
			</ul>
			{data.length === 0 && !services.isLoading ? (
				<p className='mb-3 text-body text-muted-foreground'>
					No services yet. Add one, or Deploy all to pick up what the compose file declares.
				</p>
			) : null}

			<DropdownMenu>
				<DropdownMenuTrigger render={<Button variant='primary' />}>+ New service</DropdownMenuTrigger>
				<DropdownMenuContent align='start'>
					{creatable.map(entry => (
						<DropdownMenuItem key={entry.kind} onClick={() => setCreating(entry.kind)}>
							{entry.label}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</Section>
	)
}

/**
 * One row is the whole service at a glance: what kind of thing it is, what it
 * runs and whether it is up. The image falls back to what the container was
 * actually started from, so a derived service still shows something. A service
 * whose source is still unanswered says so instead of reading as broken.
 */
function ServiceRow({ projectId, service }: { projectId: string; service: Service }) {
	const unconfigured = service.source_type === 'unconfigured'
	return (
		<li>
			<Link
				to='/projects/$projectId/services/$serviceId'
				params={{ projectId, serviceId: service.id }}
				className='flex items-center gap-3 border border-border px-3 py-2.5 transition-colors hover:border-muted-foreground'
			>
				<TypeBadge type={service.type} />
				<span className='text-body'>{service.compose_service_name}</span>
				<span className='truncate font-mono text-label text-muted-foreground'>
					{unconfigured ? '' : service.image || service.running_image || '-'}
				</span>
				<span className='ml-auto shrink-0'>
					{unconfigured ? (
						<span className='text-label text-muted-foreground'>needs a source</span>
					) : (
						<Status value={service.state || 'stopped'} />
					)}
				</span>
			</Link>
		</li>
	)
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
