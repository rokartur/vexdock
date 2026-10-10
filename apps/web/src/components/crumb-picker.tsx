import { type KeyboardEvent, type ReactNode, useId, useState } from 'react'
import { IconBox, IconDatabase, IconFolder, IconGitBranch, IconLayersLinked, IconSelector } from '@tabler/icons-react'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/arc/popover'
import { SearchField } from '@/components/arc/search-field'
import { cn } from '@/utils/cn'
import { useCurrentEnvironment, useEnvironmentId } from '../lib/environment'
import { projectQuery, projectsQuery, serviceQuery, servicesQuery } from '../lib/queries'
import { Status } from './primitives'

type Choice = {
	id: string
	/** What the search box matches against. */
	search: string
	current: boolean
	onSelect: () => void
	children: ReactNode
}

/** A breadcrumb segment that switches: the current name plus a searchable list of siblings. For `Page`'s `labels`.
 * Arc has no command menu, so this is its Popover and SearchField over a listbox the arrow keys walk. */
function CrumbPicker({
	label,
	placeholder,
	query,
	choices,
}: {
	label: ReactNode
	placeholder: string
	/** Owns the sibling list; a failure is shown in the popup with a retry. */
	query: Pick<UseQueryResult, 'isError' | 'refetch'>
	choices: Choice[] | undefined
}) {
	const [open, setOpen] = useState(false)
	const [search, setSearch] = useState('')
	const [activeIndex, setActiveIndex] = useState(0)
	const listId = useId()
	const needle = search.trim().toLowerCase()
	const shown = (choices ?? []).filter(choice => choice.search.toLowerCase().includes(needle))
	const active = shown[Math.min(activeIndex, shown.length - 1)]

	function pick(choice: Choice) {
		setOpen(false)
		choice.onSelect()
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault()
			if (!shown.length) return
			const step = event.key === 'ArrowDown' ? 1 : -1
			setActiveIndex(index => (Math.min(index, shown.length - 1) + step + shown.length) % shown.length)
		}
		if (event.key === 'Enter' && active) {
			event.preventDefault()
			pick(active)
		}
	}

	return (
		<Popover
			open={open}
			onOpenChange={next => {
				setOpen(next)
				setSearch('')
				setActiveIndex(0)
			}}
		>
			<PopoverTrigger className='flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-transparent bg-accent/50 px-2 text-body transition-colors hover:border-border hover:bg-accent data-popup-open:border-border data-popup-open:bg-accent'>
				<span className='flex min-w-0 items-center gap-2 truncate'>{label}</span>
				<IconSelector className='size-3.5 shrink-0 text-muted-foreground' />
			</PopoverTrigger>
			<PopoverContent className='w-72 p-1.5'>
				<SearchField
					label={placeholder}
					hideLabel
					placeholder={placeholder}
					value={search}
					onValueChange={value => {
						setSearch(value)
						setActiveIndex(0)
					}}
					onKeyDown={onKeyDown}
					role='combobox'
					aria-expanded
					aria-controls={listId}
					aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
				/>
				<div id={listId} role='listbox' className='mt-1.5 max-h-72 overflow-y-auto'>
					{query.isError ? (
						<button
							type='button'
							onClick={() => query.refetch()}
							className='w-full px-3 py-4 text-left text-body text-muted-foreground hover:text-foreground'
						>
							Could not load. Retry
						</button>
					) : shown.length === 0 ? (
						<p className='px-3 py-4 text-body text-muted-foreground'>No matches</p>
					) : (
						shown.map(choice => (
							<div
								key={choice.id}
								id={`${listId}-${choice.id}`}
								role='option'
								// Focus stays in the search box (aria-activedescendant); -1 only lets a click land here.
								tabIndex={-1}
								aria-selected={choice === active}
								data-checked={choice.current}
								onPointerMove={() => setActiveIndex(shown.indexOf(choice))}
								onClick={() => pick(choice)}
								onKeyDown={event => {
									if (event.key === 'Enter') pick(choice)
								}}
								className={cn(
									'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-body [&>svg]:size-4 [&>svg]:shrink-0',
									choice === active && 'bg-accent',
									choice.current && 'font-medium',
								)}
							>
								{choice.children}
							</div>
						))
					)}
				</div>
			</PopoverContent>
		</Popover>
	)
}

/** Switches between projects, keyed by the id already in the URL. */
export function ProjectCrumb({ projectId }: { projectId: string }) {
	const navigate = useNavigate()
	const projects = useQuery(projectsQuery)
	// Shared with the project's own pages, so the name is usually already cached
	// even when the list is still in flight.
	const current = useQuery(projectQuery(projectId))

	return (
		<CrumbPicker
			placeholder='Find project…'
			query={projects}
			label={
				<>
					<IconFolder className='size-4 shrink-0 text-muted-foreground' />
					{current.data?.name ?? projectId}
					{current.data?.latest_deployment ? (
						<Status dot value={current.data.latest_deployment.status} />
					) : null}
				</>
			}
			choices={projects.data?.map(project => ({
				id: project.id,
				search: `${project.name} ${project.slug}`,
				current: project.id === projectId,
				// Clearing the environment is deliberate: the id in the URL belongs to the project being left behind.
				onSelect: () => {
					navigate({
						to: '/projects/$projectId',
						params: { projectId: project.id },
						search: { env: undefined },
					})
				},
				children: (
					<>
						<IconFolder className='text-muted-foreground' />
						<span className='truncate'>{project.name}</span>
						<span className='ml-auto flex items-center gap-1.5'>
							{project.latest_deployment ? <Status dot value={project.latest_deployment.status} /> : null}
							<span className='font-mono text-meta text-muted-foreground tabular-nums'>
								{project.running_count}/{project.service_count}
							</span>
						</span>
					</>
				),
			}))}
		/>
	)
}

/**
 * Switches which environment the pages below act on. Unlike the other two this
 * changes a search param rather than the path, so the current tab stays open.
 */
export function EnvironmentCrumb({ projectId }: { projectId: string }) {
	// `to: '.'` is what keeps the current page open while the environment
	// underneath it changes, on a project page and on a service page alike.
	const navigate = useNavigate()
	const { environments, current } = useCurrentEnvironment(projectId)

	return (
		<CrumbPicker
			placeholder='Find environment…'
			query={environments}
			label={
				<>
					<IconLayersLinked className='size-4 shrink-0 text-muted-foreground' />
					{current?.name ?? 'Production'}
				</>
			}
			choices={environments.data?.map(env => ({
				id: env.id,
				search: `${env.name} ${env.slug}`,
				current: env.id === current?.id,
				onSelect: () => {
					navigate({ to: '.', search: prev => ({ ...prev, env: env.id }) })
				},
				children: (
					<>
						<IconLayersLinked className='text-muted-foreground' />
						<span className='truncate'>{env.name}</span>
						{env.branch ? (
							<span className='ml-auto inline-flex items-center gap-1 truncate font-mono text-meta text-muted-foreground'>
								<IconGitBranch className='size-3' />
								{env.branch}
							</span>
						) : null}
					</>
				),
			}))}
		/>
	)
}

/** Switches between the services of the project the URL already names. */
export function ServiceCrumb({ projectId, serviceId }: { projectId: string; serviceId: string }) {
	const navigate = useNavigate()
	const environmentId = useEnvironmentId()
	const services = useQuery(servicesQuery(projectId, environmentId))
	// The name and state come from the service's own query, which the page around
	// this crumb polls and every action invalidates, so the crumb survives a
	// failure of the sibling list without a second poll of its own.
	const current = useQuery(serviceQuery(serviceId))

	return (
		<CrumbPicker
			placeholder='Find service…'
			query={services}
			label={
				<>
					{current.data?.type === 'database' ? (
						<IconDatabase className='size-4 shrink-0 text-muted-foreground' />
					) : (
						<IconBox className='size-4 shrink-0 text-muted-foreground' />
					)}
					{current.data?.compose_service_name ?? serviceId}
					{current.data ? <Status dot value={current.data.state || 'stopped'} /> : null}
				</>
			}
			choices={services.data?.map(service => ({
				id: service.id,
				search: `${service.compose_service_name} ${service.display_name}`,
				current: service.id === serviceId,
				onSelect: () => {
					navigate({
						to: '/projects/$projectId/services/$serviceId',
						params: { projectId, serviceId: service.id },
					})
				},
				children: (
					<>
						{service.type === 'database' ? (
							<IconDatabase className='text-muted-foreground' />
						) : (
							<IconBox className='text-muted-foreground' />
						)}
						<span className='truncate'>{service.compose_service_name}</span>
						<span className='ml-auto text-meta'>
							<Status value={service.state || 'stopped'} />
						</span>
					</>
				),
			}))}
		/>
	)
}
