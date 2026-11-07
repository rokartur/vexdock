import { type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react'
import {
	IconBox,
	IconCheck,
	IconChevronRight,
	IconDatabase,
	IconFolder,
	IconGitBranch,
	IconLayersLinked,
	IconRefresh,
	IconSelector,
} from '@tabler/icons-react'
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { cn } from 'cn'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SearchField } from '@/components/ui/search-field'
import { Skeleton } from '@/components/ui/skeleton'
import { useCurrentEnvironment, useEnvironmentId } from '../lib/environment'
import { projectQuery, projectsQuery, serviceQuery, servicesQuery } from '../lib/queries'
import { Button, Status } from './primitives'

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
	noun,
	query,
	choices,
}: {
	label: ReactNode
	placeholder: string
	/** What the list holds, plural ("projects"), for its loading state and its error. */
	noun: string
	/** Owns the sibling list; a failure is shown in the popup with a retry. */
	query: Pick<UseQueryResult, 'isError' | 'isFetching' | 'refetch'>
	choices: Choice[] | undefined
}) {
	const [open, setOpen] = useState(false)
	const [search, setSearch] = useState('')
	const [activeIndex, setActiveIndex] = useState(0)
	const listId = useId()
	const noteId = useId()
	const listRef = useRef<HTMLDivElement>(null)
	const needle = search.trim().toLowerCase()
	const shown = (choices ?? []).filter(choice => choice.search.toLowerCase().includes(needle))
	const active = shown[Math.min(activeIndex, shown.length - 1)]
	const activeId = active ? `${listId}-${active.id}` : undefined

	function pick(choice: Choice) {
		setOpen(false)
		choice.onSelect()
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault()
			if (!shown.length) return
			const step = event.key === 'ArrowDown' ? 1 : -1
			const index = (Math.min(activeIndex, shown.length - 1) + step + shown.length) % shown.length
			setActiveIndex(index)
			// Only an arrow key scrolls: under the pointer, scrolling would slide a half-visible option away from it.
			listRef.current?.querySelector(`[id="${listId}-${shown[index]?.id}"]`)?.scrollIntoView({ block: 'nearest' })
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
				// Reset on open: clearing on close would refill the list while the popup fades out.
				if (!next) return
				setSearch('')
				setActiveIndex(0)
			}}
		>
			<PopoverTrigger className='-mx-1.5 flex h-7 min-w-0 press items-center gap-1.5 rounded-control px-1.5 text-sm hover:bg-surface-muted active:bg-surface-pressed data-popup-open:bg-surface-muted pointer-coarse:h-11'>
				<span className='flex min-w-0 items-center gap-2 truncate'>{label}</span>
				<IconSelector stroke={1.75} className='size-3.5 shrink-0 text-muted' />
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
					aria-activedescendant={activeId}
					// The note mounts with the popup, so a list that already failed or is empty is read from here, not the live region.
					aria-describedby={noteId}
				/>
				{/* Only options live in the listbox; the loading, error and no-match notes sit below it. */}
				<div
					ref={listRef}
					id={listId}
					role='listbox'
					aria-label={noun}
					className='relative mt-1.5 max-h-72 overflow-y-auto empty:hidden'
				>
					{shown.length > 0 ? <GlidingHighlight activeId={activeId} needle={needle} /> : null}
					{shown.map(choice => (
						// oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- keys stay in the search box, which handles Enter
						<div
							key={choice.id}
							id={`${listId}-${choice.id}`}
							role='option'
							// Focus stays in the search box (aria-activedescendant); -1 only lets a click land here.
							tabIndex={-1}
							aria-selected={choice === active}
							aria-current={choice.current || undefined}
							onPointerMove={() => setActiveIndex(shown.indexOf(choice))}
							onClick={() => pick(choice)}
							className={cn(
								'relative flex items-center gap-2 rounded-control py-1.5 pr-8 pl-2 text-sm pointer-coarse:min-h-11 [&>svg]:size-4 [&>svg]:shrink-0',
								choice.current && 'font-medium',
							)}
						>
							{choice.children}
							{choice.current ? (
								<IconCheck
									stroke={1.75}
									aria-hidden='true'
									className='absolute right-2.5 text-foreground'
								/>
							) : null}
						</div>
					))}
				</div>
				<ListNote
					id={noteId}
					noun={noun}
					query={query}
					loading={choices === undefined}
					empty={shown.length === 0}
				/>
			</PopoverContent>
		</Popover>
	)
}

/** One highlight glides between options (Arc's gliding highlight) instead of each option lighting its own background.
 * It mounts inside the portaled listbox, so its first measure finds the options; that first placement lands in place. */
function GlidingHighlight({ activeId, needle }: { activeId: string | undefined; needle: string }) {
	const ref = useRef<HTMLSpanElement>(null)
	const [glide, setGlide] = useState({ top: 0, height: 0, moved: false })
	useLayoutEffect(() => {
		const node = ref.current?.parentElement?.querySelector<HTMLElement>('[aria-selected="true"]')
		if (!node) return
		setGlide(last => ({ top: node.offsetTop, height: node.offsetHeight, moved: last.height > 0 }))
		// A new query moves the same option up or down the list, so it re-measures too.
	}, [activeId, needle])
	return (
		<span
			ref={ref}
			aria-hidden
			className={cn(
				'pointer-events-none absolute inset-x-0 top-0 rounded-control bg-surface-muted',
				glide.moved && 'transition-[translate,height] duration-110 ease-standard motion-reduce:transition-none',
			)}
			style={{ translate: `0 ${glide.top}px`, height: glide.height }}
		/>
	)
}

/** What the popup says when there is no list to walk yet, the list failed, or the search matches nothing. */
function ListNote({
	id,
	noun,
	query,
	loading,
	empty,
}: {
	id: string
	noun: string
	query: Pick<UseQueryResult, 'isError' | 'isFetching' | 'refetch'>
	loading: boolean
	empty: boolean
}) {
	const message = query.isError ? `Could not load ${noun}` : !loading && empty ? 'No matches' : null
	// The status line stays mounted in every branch: a live region that mounts already full is not announced by most
	// screen readers.
	return (
		<>
			{loading && !query.isError ? <Skeleton label={`Loading ${noun}`} lines={3} className='px-2 py-2' /> : null}
			<div
				className={cn(
					'flex items-center justify-between gap-2 text-sm text-muted',
					query.isError && 'mt-1.5 py-1 pr-1 pl-2',
					message && !query.isError && 'px-3 py-4',
				)}
			>
				<p id={id} role='status'>
					{message}
				</p>
				{query.isError ? (
					<Button variant='ghost' loading={query.isFetching} onClick={() => query.refetch()}>
						<IconRefresh size={16} stroke={1.75} />
						Try again
					</Button>
				) : null}
			</div>
		</>
	)
}

/** The chevron `Breadcrumb` draws, for two pickers sharing one segment. */
export function CrumbSeparator() {
	return <IconChevronRight size={16} stroke={1.75} aria-hidden='true' className='flex-none text-border-strong' />
}

/** Switches between projects, keyed by the id already in the URL. */
export function ProjectCrumb({ projectId }: { projectId: string }) {
	const navigate = useNavigate()
	const environmentId = useEnvironmentId()
	const projects = useQuery(projectsQuery)
	// Shared with the project's own pages, so the name is usually already cached
	// even when the list is still in flight.
	const current = useQuery(projectQuery(projectId))

	return (
		<CrumbPicker
			placeholder='Find project…'
			noun='projects'
			query={projects}
			label={
				<>
					<IconFolder stroke={1.75} className='size-4 shrink-0 text-muted' />
					{current.data?.name ?? <TriggerPlaceholder label='project' failed={current.isError} />}
					{current.data?.latest_deployment ? (
						<Status dot run value={current.data.latest_deployment.status} />
					) : null}
				</>
			}
			choices={projects.data?.map(project => ({
				id: project.id,
				search: `${project.name} ${project.slug}`,
				current: project.id === projectId,
				// Leaving the project clears the environment: its id belongs to the project left behind.
				onSelect: () => {
					navigate({
						to: '/projects/$projectId',
						params: { projectId: project.id },
						search: { env: project.id === projectId ? environmentId : undefined },
						// The picker's exit is the motion; a page swap would freeze it in the snapshot.
						viewTransition: false,
					})
				},
				children: (
					<>
						<IconFolder size={16} stroke={1.75} className='text-muted' />
						<span className='truncate'>{project.name}</span>
						<span className='ml-auto flex items-center gap-1.5'>
							{project.latest_deployment ? (
								<Status dot run value={project.latest_deployment.status} />
							) : null}
							<span className='font-mono text-xs text-muted tabular-nums'>
								<span aria-hidden>
									{project.running_count}/{project.service_count}
								</span>
								<span className='sr-only'>
									{project.running_count} of {project.service_count} services running
								</span>
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
 * A service lives in one environment, so on a service page (`serviceId`) the
 * switch opens the same-named service there, or the project page when it has none.
 */
export function EnvironmentCrumb({ projectId, serviceId }: { projectId: string; serviceId?: string }) {
	const navigate = useNavigate()
	const router = useRouter()
	const queryClient = useQueryClient()
	const service = useQuery({ ...serviceQuery(serviceId ?? ''), enabled: serviceId !== undefined })
	const { environments, current: selected } = useCurrentEnvironment(projectId, service.data?.environment_id)
	// On a service page only the service's own environment is true; until it answers, name none.
	const current = serviceId && !service.data ? undefined : selected
	const waiting = environments.isPending || (serviceId !== undefined && service.isPending)
	const latestSwitch = useRef(0)
	// The environment opening while the twin lookup runs, announced outside the trigger (a button drops status roles).
	const [switching, setSwitching] = useState<string>()

	const switchTo = async (environmentId: string) => {
		if (!serviceId) return navigate({ to: '.', search: previous => ({ ...previous, env: environmentId }) })
		const from = router.state.location.href
		latestSwitch.current += 1
		const attempt = latestSwitch.current
		setSwitching(environments.data?.find(env => env.id === environmentId)?.name ?? 'the environment')
		// A failed read lands on the project page, which shows the error itself.
		const services = await queryClient.fetchQuery(servicesQuery(projectId, environmentId)).catch(() => [])
		// A later pick, or a page the reader moved to while the list loaded, wins over this one.
		if (attempt !== latestSwitch.current) return
		setSwitching(undefined)
		if (router.state.location.href !== from) return
		const twin = services.find(other => other.compose_service_name === service.data?.compose_service_name)
		if (!twin)
			return navigate({
				to: '/projects/$projectId',
				params: { projectId },
				search: { env: environmentId },
				viewTransition: false,
			})
		// `to: '.'` keeps the open tab; only the service under it changes. The picker's exit is the motion.
		return navigate({
			to: '.',
			params: previous => ({ ...previous, serviceId: twin.id }),
			search: previous => ({ ...previous, env: environmentId }),
			viewTransition: false,
		})
	}

	return (
		<>
			<span role='status' className='sr-only'>
				{switching ? `Opening ${service.data?.compose_service_name ?? 'the project'} in ${switching}` : ''}
			</span>
			<CrumbPicker
				placeholder='Find environment…'
				noun='environments'
				query={environments}
				label={
					<>
						<IconLayersLinked stroke={1.75} className='size-4 shrink-0 text-muted' />
						{current && !switching ? (
							current.name
						) : (
							<TriggerPlaceholder label='environment' failed={!switching && !waiting} />
						)}
					</>
				}
				choices={environments.data?.map(env => ({
					id: env.id,
					search: `${env.name} ${env.slug}`,
					current: env.id === current?.id,
					onSelect: () => switchTo(env.id),
					children: (
						<>
							<IconLayersLinked size={16} stroke={1.75} className='text-muted' />
							<span className='truncate'>{env.name}</span>
							{env.branch ? (
								<span className='ml-auto inline-flex items-center gap-1 truncate font-mono text-xs text-muted'>
									<IconGitBranch stroke={1.75} className='size-3' />
									{env.branch}
								</span>
							) : null}
						</>
					),
				}))}
			/>
		</>
	)
}

/** Switches between the services of the project the URL already names. */
export function ServiceCrumb({ projectId, serviceId }: { projectId: string; serviceId: string }) {
	const navigate = useNavigate()
	// The name and state come from the service's own query, which the page around
	// this crumb polls and every action invalidates, so the crumb survives a
	// failure of the sibling list without a second poll of its own.
	const current = useQuery(serviceQuery(serviceId))
	// Siblings are the services of this service's environment, whatever `?env=` says.
	const services = useQuery({
		...servicesQuery(projectId, current.data?.environment_id),
		enabled: current.data !== undefined,
	})

	return (
		<CrumbPicker
			placeholder='Find service…'
			noun='services'
			// The siblings wait on the service, so its failure is the list's failure, and Try again retries it.
			query={current.isError ? current : services}
			label={
				<>
					{current.data?.type === 'database' ? (
						<IconDatabase stroke={1.75} className='size-4 shrink-0 text-muted' />
					) : (
						<IconBox stroke={1.75} className='size-4 shrink-0 text-muted' />
					)}
					{current.data?.compose_service_name ?? (
						<TriggerPlaceholder label='service' failed={current.isError} />
					)}
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
						viewTransition: false,
					})
				},
				children: (
					<>
						{service.type === 'database' ? (
							<IconDatabase size={16} stroke={1.75} className='text-muted' />
						) : (
							<IconBox size={16} stroke={1.75} className='text-muted' />
						)}
						<span className='truncate'>{service.compose_service_name}</span>
						<span className='ml-auto text-xs'>
							<Status value={service.state || 'stopped'} />
						</span>
					</>
				),
			}))}
		/>
	)
}

/** A static bar where the name will go: a trigger is a button, which may hold only phrasing content. */
function TriggerPlaceholder({ label, failed }: { label: string; failed: boolean }) {
	if (failed) return '-'
	return (
		<span className='inline-block h-3 w-20 rounded-[3px] bg-surface-muted'>
			<span className='sr-only'>Loading {label}</span>
		</span>
	)
}
