import { type ReactNode, useState } from 'react'
import { IconChevronDown } from '@tabler/icons-react'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '../lib/api'
import { useEnvironmentId } from '../lib/environment'
import { Status } from './primitives'

/**
 * A breadcrumb segment that is also a switcher: the current name plus a
 * searchable list of its siblings. Pages hand one of these to `Page`'s
 * `labels`, so the trail stays derived from the URL and only its rendering
 * changes.
 */
function CrumbPicker({
	label,
	placeholder,
	query,
	children,
}: {
	label: ReactNode
	placeholder: string
	/** Owns the sibling list; a failure is shown in the popup with a retry. */
	query: Pick<UseQueryResult, 'isError' | 'refetch'>
	children: (close: () => void) => ReactNode
}) {
	const [open, setOpen] = useState(false)

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger className='-mx-1 flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 hover:bg-accent data-popup-open:bg-accent'>
				<span className='flex min-w-0 items-center gap-2 truncate'>{label}</span>
				<IconChevronDown className='size-3 shrink-0 text-muted-foreground' />
			</PopoverTrigger>
			<PopoverContent align='start' className='w-72 gap-0 p-0'>
				<Command>
					<CommandInput placeholder={placeholder} />
					<CommandList>
						{query.isError ? (
							<button
								type='button'
								onClick={() => query.refetch()}
								className='w-full px-3 py-4 text-left text-body text-muted-foreground hover:text-foreground'
							>
								Could not load. Retry
							</button>
						) : (
							<>
								<CommandEmpty>No matches</CommandEmpty>
								{children(() => setOpen(false))}
							</>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}

/** Switches between projects, keyed by the id already in the URL. */
export function ProjectCrumb({ projectId }: { projectId: string }) {
	const navigate = useNavigate()
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
	// Shared with the project's own pages, so the name is usually already cached
	// even when the list is still in flight. The poll keeps the deploy status in
	// the crumb honest, since this is the only place it shows on every tab.
	const current = useQuery({
		queryKey: ['project', projectId],
		queryFn: () => api.project(projectId),
		refetchInterval: 10_000,
	})

	return (
		<CrumbPicker
			placeholder='Find project…'
			query={projects}
			label={
				<>
					{current.data?.name ?? projectId}
					{current.data?.latest_deployment ? <Status value={current.data.latest_deployment.status} /> : null}
				</>
			}
		>
			{close =>
				projects.data?.map(project => {
					const isCurrent = project.id === projectId
					return (
						<CommandItem
							key={project.id}
							value={`${project.name} ${project.slug}`}
							data-checked={isCurrent}
							onSelect={() => {
								close()
								// Clearing the environment is deliberate: the id in the URL
								// belongs to the project being left behind.
								void navigate({
									to: '/projects/$projectId',
									params: { projectId: project.id },
									search: { env: undefined },
								})
							}}
						>
							<span className='truncate'>{project.name}</span>
							{isCurrent ? null : (
								<span className='ml-auto font-mono text-meta text-muted-foreground'>
									{project.running_count}/{project.service_count}
								</span>
							)}
						</CommandItem>
					)
				})
			}
		</CrumbPicker>
	)
}

/**
 * Switches which environment the pages below act on. Unlike the other two this
 * changes a search param rather than the path, so the current tab stays open.
 */
export function EnvironmentCrumb({ projectId }: { projectId: string }) {
	// `from` only types the search shape here; leaving `to` off is what keeps the
	// current tab open while the environment underneath it changes.
	const navigate = useNavigate({ from: '/projects/$projectId' })
	const selected = useEnvironmentId()
	const environments = useQuery({ queryKey: ['environments', projectId], queryFn: () => api.environments(projectId) })
	// No selection means the default one, which is also what the manager assumes.
	const current = environments.data?.find(env => (selected ? env.id === selected : env.is_default))

	return (
		<CrumbPicker placeholder='Find environment…' query={environments} label={current?.name ?? 'Production'}>
			{close =>
				environments.data?.map(env => (
					<CommandItem
						key={env.id}
						value={`${env.name} ${env.slug}`}
						data-checked={env.id === current?.id}
						onSelect={() => {
							close()
							void navigate({ search: prev => ({ ...prev, env: env.id }) })
						}}
					>
						<span className='truncate'>{env.name}</span>
						{env.branch ? (
							<span className='ml-auto font-mono text-meta text-muted-foreground'>{env.branch}</span>
						) : null}
					</CommandItem>
				))
			}
		</CrumbPicker>
	)
}

/** Switches between the services of the project the URL already names. */
export function ServiceCrumb({ projectId, serviceId }: { projectId: string; serviceId: string }) {
	const navigate = useNavigate()
	const environmentId = useEnvironmentId()
	const services = useQuery({
		queryKey: ['services', projectId, environmentId],
		queryFn: () => api.services(projectId, environmentId),
	})
	// The name and state come from the service's own query, which the page already
	// polls and every action invalidates, so the crumb survives a failure of the
	// sibling list and does not poll it a second time.
	const current = useQuery({
		queryKey: ['service', serviceId],
		queryFn: () => api.service(serviceId),
		refetchInterval: 5000,
	})

	return (
		<CrumbPicker
			placeholder='Find service…'
			query={services}
			label={
				<>
					{current.data?.compose_service_name ?? serviceId}
					{current.data ? <Status value={current.data.state || 'stopped'} /> : null}
				</>
			}
		>
			{close =>
				services.data?.map(service => {
					const isCurrent = service.id === serviceId
					return (
						<CommandItem
							key={service.id}
							value={`${service.compose_service_name} ${service.display_name}`}
							data-checked={isCurrent}
							onSelect={() => {
								close()
								void navigate({
									to: '/projects/$projectId/services/$serviceId',
									params: { projectId, serviceId: service.id },
								})
							}}
						>
							<span className='truncate'>{service.compose_service_name}</span>
							{isCurrent ? null : (
								<span className='ml-auto'>
									<Status value={service.state || 'stopped'} />
								</span>
							)}
						</CommandItem>
					)
				})
			}
		</CrumbPicker>
	)
}
