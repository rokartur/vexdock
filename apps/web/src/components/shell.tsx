import { useEffect, useState, type ReactNode } from 'react'
import {
	IconActivity,
	IconAffiliate,
	IconArchive,
	IconBox,
	IconCertificate,
	IconChevronDown,
	IconChevronRight,
	IconClock,
	IconDatabase,
	IconFolder,
	IconHome,
	IconLogout,
	IconMenu2,
	IconPlus,
	IconSettings,
	IconStack2,
	IconTrash,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/utils/cn'
import { api, updateActive, type Project } from '../lib/api'
import { signOut, useSession } from '../lib/auth-client'
import { useEnvironmentId } from '../lib/environment'
import { useSystemEvents } from '../lib/sse'
import { NewProjectDialog } from './new-project'
import { PageChrome, stateTone } from './primitives'

type NavItem = { to: string; label: string; icon: TablerIcon; exact?: boolean }

const projects: NavItem = { to: '/projects', label: 'Projects', icon: IconFolder }

const home: NavItem[] = [
	{ to: '/', label: 'Dashboard', icon: IconHome, exact: true },
	{ to: '/tasks', label: 'Tasks', icon: IconClock },
]

const docker: NavItem[] = [
	{ to: '/docker/containers', label: 'Containers', icon: IconBox },
	{ to: '/docker/images', label: 'Images', icon: IconStack2 },
	{ to: '/docker/volumes', label: 'Volumes', icon: IconDatabase },
	{ to: '/docker/networks', label: 'Networks', icon: IconAffiliate },
]

const system: NavItem[] = [
	{ to: '/system', label: 'Overview', icon: IconActivity, exact: true },
	{ to: '/system/certificates', label: 'Certificates', icon: IconCertificate },
	{ to: '/system/docker', label: 'Cleanup', icon: IconTrash },
	{ to: '/system/backups', label: 'Backups', icon: IconArchive },
	{ to: '/system/settings', label: 'Settings', icon: IconSettings },
]

const isActive = (item: NavItem, pathname: string) => (item.exact ? pathname === item.to : pathname.startsWith(item.to))

const navRow =
	'flex items-center gap-2 rounded-md px-2 py-1.5 text-body transition-colors data-[on=false]:text-muted-foreground data-[on=false]:hover:bg-muted data-[on=false]:hover:text-foreground data-[on=true]:bg-muted data-[on=true]:font-medium data-[on=true]:text-foreground'

function SideLink({ item, active }: { item: NavItem; active: boolean }) {
	return (
		<Link
			to={item.to}
			draggable={false}
			aria-current={active ? 'page' : undefined}
			data-on={active}
			className={navRow}
		>
			<item.icon stroke={1.5} className='size-4 shrink-0' />
			<span className='truncate'>{item.label}</span>
		</Link>
	)
}

function GroupLabel({ children }: { children: ReactNode }) {
	return <div className='px-2 pt-4 pb-1 font-mono text-meta tracking-wide text-muted-foreground'>{children}</div>
}

/** The project you are in is always open; every other one opens on its chevron, and only an open one fetches services. */
function ProjectTree() {
	const { projectId } = useParams({ strict: false })
	const environmentId = useEnvironmentId()
	const [opened, setOpened] = useState<string[]>([])
	const list = useQuery({ queryKey: ['projects'], queryFn: api.projects })

	if (!list.data) return null
	return (
		<>
			{list.data.map(project => {
				const active = project.id === projectId
				return (
					<ProjectBranch
						key={project.id}
						project={project}
						active={active}
						open={active || opened.includes(project.id)}
						// The environment is the project's own, so a link out of this
						// project must drop the one in the URL or the manager 404s it.
						environmentId={active ? environmentId : undefined}
						onToggle={() =>
							setOpened(open =>
								open.includes(project.id)
									? open.filter(id => id !== project.id)
									: [...open, project.id],
							)
						}
					/>
				)
			})}
		</>
	)
}

function ProjectBranch({
	project,
	active,
	open,
	environmentId,
	onToggle,
}: {
	project: Project
	active: boolean
	open: boolean
	environmentId: string | undefined
	onToggle: () => void
}) {
	return (
		<div>
			<div className='flex items-center gap-0.5'>
				<button
					type='button'
					onClick={onToggle}
					aria-expanded={open}
					aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`}
					className='rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground'
				>
					<IconChevronRight
						stroke={1.5}
						className={cn('size-3.5 transition-transform', open && 'rotate-90')}
					/>
				</button>
				<Link
					to='/projects/$projectId'
					params={{ projectId: project.id }}
					search={{ env: environmentId }}
					draggable={false}
					aria-current={active ? 'page' : undefined}
					data-on={active}
					className={cn(navRow, 'min-w-0 flex-1')}
				>
					<span className='truncate'>{project.name}</span>
					<span className='ml-auto shrink-0 font-mono text-meta text-muted-foreground'>
						{project.service_count}
					</span>
				</Link>
			</div>
			{open ? <BranchServices projectId={project.id} environmentId={environmentId} /> : null}
		</div>
	)
}

function BranchServices({ projectId, environmentId }: { projectId: string; environmentId: string | undefined }) {
	const { serviceId } = useParams({ strict: false })
	// The same key the project's own page uses, so opening a branch you are
	// already on costs nothing.
	const services = useQuery({
		queryKey: ['services', projectId, environmentId],
		queryFn: () => api.services(projectId, environmentId),
	})

	if (!services.data) return null
	return (
		<div className='mt-0.5 ml-3.5 border-l pl-2'>
			{services.data.length === 0 ? (
				<div className='px-2 py-1 text-label text-muted-foreground'>No services</div>
			) : (
				services.data.map(service => (
					<Link
						key={service.id}
						to='/projects/$projectId/services/$serviceId'
						params={{ projectId, serviceId: service.id }}
						search={{ env: environmentId }}
						draggable={false}
						aria-current={service.id === serviceId ? 'page' : undefined}
						data-on={service.id === serviceId}
						className={cn(navRow, 'py-1')}
					>
						<span
							aria-hidden
							className={cn('size-1.5 shrink-0 rounded-full bg-current', stateTone(service.state))}
						/>
						<span className='truncate'>{service.compose_service_name}</span>
					</Link>
				))
			)}
		</div>
	)
}

/** The sidebar carries every destination and the project tree; the header above the page carries its breadcrumb and actions. */
export function Shell({ children }: { children: ReactNode }) {
	const [navOpen, setNavOpen] = useState(false)
	const [creating, setCreating] = useState(false)
	// Set from the ref during commit, so the page's breadcrumb lands in the bar
	// before the first paint rather than a frame later.
	const [header, setHeader] = useState<HTMLElement | null>(null)
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const pathname = useRouterState({ select: state => state.location.pathname })

	// The whole panel's refresh loop: docker and deployment events invalidate the
	// mounted queries, so pages do not poll for what the server can announce.
	useSystemEvents()
	const version = useQuery({ queryKey: ['version'], queryFn: api.version, refetchInterval: 60_000 })
	const updateAvailable = version.data?.update_available ?? false
	// The update state is a tiny file read; polling it keeps the bar honest
	// about an update started on another page (or by another session).
	const updateState = useQuery({
		queryKey: ['update-state'],
		queryFn: api.updateState,
		retry: false,
		refetchInterval: 10_000,
	})
	// A failing fetch while the last known phase was active is the manager
	// being swapped, not an error.
	const updating = updateActive(updateState.data?.phase)
	const restarting = updating && updateState.isError

	let updateDot: string | undefined
	let versionText = version.data?.current ?? 'dev'
	let versionClass = 'text-muted-foreground'
	if (updating) {
		updateDot = 'bg-amber-400'
		versionText = restarting ? 'restarting…' : `updating → ${updateState.data?.target}`
		versionClass = 'text-amber-400'
	} else if (updateAvailable) {
		updateDot = 'bg-emerald-400'
		versionText = `${version.data?.current} → ${version.data?.latest}`
		versionClass = 'text-emerald-400'
	}
	const session = useSession()

	const logout = useMutation({
		mutationFn: () => signOut(),
		onSuccess: async () => {
			queryClient.clear()
			await navigate({ to: '/login', replace: true })
		},
	})

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			// Cmd/Ctrl+S submits the FormSection the caret is in (requestSubmit, so
			// its `required` inputs are checked first); anywhere else it is swallowed
			// so the browser never offers to save the page.
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
				event.preventDefault()
				if (event.target instanceof Element)
					event.target.closest<HTMLFormElement>('form[data-saves]')?.requestSubmit()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	useEffect(() => setNavOpen(false), [pathname])

	const email = session.data?.user.email ?? ''
	const name = session.data?.user.name || 'Account'

	return (
		<div className='flex h-dvh min-h-0 overflow-hidden'>
			{navOpen ? (
				<button
					type='button'
					aria-label='Close navigation'
					onClick={() => setNavOpen(false)}
					className='fixed inset-0 z-40 bg-black/60 md:hidden'
				/>
			) : null}

			<aside
				className={cn(
					'w-64 shrink-0 flex-col border-r bg-background max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-72',
					navOpen ? 'flex' : 'hidden md:flex',
				)}
			>
				<div className='flex h-12 shrink-0 items-center gap-2 border-b px-3'>
					<Link
						to='/'
						draggable={false}
						className='mr-auto flex min-w-0 items-center gap-2 rounded-md p-1 text-body hover:bg-muted'
					>
						<Avatar className='size-5 rounded-sm'>
							<AvatarFallback className='rounded-sm bg-primary text-[10px] font-semibold text-primary-foreground'>
								VX
							</AvatarFallback>
						</Avatar>
						<span className='truncate font-medium'>vexdock</span>
					</Link>
				</div>

				<nav className='min-h-0 flex-1 overflow-y-auto px-2 pb-2'>
					<div className='pt-2'>
						{home.map(item => (
							<SideLink key={item.to} item={item} active={isActive(item, pathname)} />
						))}
					</div>
					<GroupLabel>
						<div className='flex items-center justify-between gap-2'>
							<Link
								to='/projects'
								draggable={false}
								data-on={pathname === projects.to}
								className='hover:text-foreground data-[on=true]:text-foreground'
							>
								Projects
							</Link>
							<button
								type='button'
								onClick={() => setCreating(true)}
								aria-label='New project'
								className='-my-1 rounded-md p-1 hover:bg-muted hover:text-foreground'
							>
								<IconPlus stroke={1.5} className='size-3.5' />
							</button>
						</div>
					</GroupLabel>
					<NewProjectDialog open={creating} onOpenChange={setCreating} />
					<ProjectTree />
					<GroupLabel>Docker</GroupLabel>
					{docker.map(item => (
						<SideLink key={item.to} item={item} active={isActive(item, pathname)} />
					))}
					<GroupLabel>System</GroupLabel>
					{system.map(item => (
						<SideLink key={item.to} item={item} active={isActive(item, pathname)} />
					))}
				</nav>

				<div className='shrink-0 border-t p-2'>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<button
									type='button'
									aria-label='Account'
									className='flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-muted'
								/>
							}
						>
							<Avatar className='size-6 shrink-0 rounded-md'>
								<AvatarFallback className='rounded-md bg-secondary text-[10px] font-medium'>
									{(email || '?').slice(0, 2).toUpperCase()}
								</AvatarFallback>
							</Avatar>
							<span className='min-w-0 flex-1'>
								<span className='block truncate text-body font-medium'>{name}</span>
								{email ? (
									<span className='block truncate text-label text-muted-foreground'>{email}</span>
								) : null}
							</span>
							<IconChevronDown className='size-3.5! shrink-0 text-muted-foreground' />
						</DropdownMenuTrigger>
						<DropdownMenuContent side='top' align='start' sideOffset={8} className='w-56'>
							<DropdownMenuItem render={<Link to='/system/settings' />}>
								<IconSettings />
								Settings
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={() => logout.mutate()}>
								<IconLogout />
								Log out
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					<Link
						to='/system/settings/about'
						draggable={false}
						className={cn('flex items-center gap-1.5 px-2 pt-1 font-mono text-meta', versionClass)}
					>
						{updateDot ? <span aria-hidden className={cn('size-1.5 rounded-full', updateDot)} /> : null}
						{versionText}
					</Link>
				</div>
			</aside>

			<div className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
				<header className='flex h-12 shrink-0 items-center gap-2 border-b px-3'>
					<button
						type='button'
						aria-label='Navigation'
						onClick={() => setNavOpen(true)}
						className='-ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden'
					>
						<IconMenu2 stroke={1.5} className='size-4' />
					</button>
					{/* The page's breadcrumb and actions land here, so a page owns what it
					    is called without owning a bar of its own. */}
					<div ref={setHeader} className='flex min-w-0 flex-1 items-center gap-3 overflow-hidden' />
				</header>

				<PageChrome value={header}>{children}</PageChrome>
			</div>
		</div>
	)
}
