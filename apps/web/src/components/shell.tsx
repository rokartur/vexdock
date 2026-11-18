import { useEffect, useState, type ReactNode } from 'react'
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import {
	IconActivity,
	IconAffiliate,
	IconArchive,
	IconBox,
	IconCertificate,
	IconChartBar,
	IconClock,
	IconDatabase,
	IconFolder,
	IconHome,
	IconInfoCircle,
	IconLogout,
	IconRefresh,
	IconSearch,
	IconSettings,
	IconStack2,
	IconTrash,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { cn } from 'cn'
import { Avatar } from '@/components/ui/avatar'
import { DropdownMenu } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { updateActive } from '../lib/api'
import { signOut, useSession } from '../lib/auth-client'
import { useEnvironmentId } from '../lib/environment'
import { useFocusRescue } from '../lib/focus-rescue'
import { projectsQuery, updateStateQuery, versionQuery } from '../lib/queries'
import { useSystemEvents } from '../lib/sse'
import { CommandMenu } from './command-menu'
import { DeploymentInbox } from './deployment-inbox'
import { Logo } from './logo'
import { IconButton, PageChrome } from './primitives'
import { Sidebar, SidebarItem, SidebarLink, SidebarSection } from './sidebar'

type NavItem = { to: string; label: string; icon: TablerIcon; exact?: boolean }

const home: NavItem[] = [
	{ to: '/', label: 'Dashboard', icon: IconHome, exact: true },
	{ to: '/analytics', label: 'Analytics', icon: IconChartBar },
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
]

const settings: NavItem = { to: '/system/settings', label: 'Settings', icon: IconSettings }

/** rarv's org layout: a topbar over a sidebar that folds to a 64 wide rail on `[` and is a drawer below 768 px, and
 * the page as an inset card. */
export function Shell({ children }: { children: ReactNode }) {
	const [collapsed, setCollapsed] = useState(false)
	const [closed, setClosed] = useState<string[]>([])
	const [searchOpen, setSearchOpen] = useState(false)
	const [announcement, setAnnouncement] = useState('')
	// Set from the ref during commit, so the page's title lands in the topbar before the first paint.
	const [header, setHeader] = useState<HTMLElement | null>(null)

	// The whole panel's refresh loop: docker and deployment events invalidate the
	// mounted queries, so pages do not poll for what the server can announce.
	const eventsLost = useSystemEvents() === 'lost'
	const [saidLost, setSaidLost] = useState(false)
	if (eventsLost !== saidLost) {
		setSaidLost(eventsLost)
		setAnnouncement(eventsLost ? 'Live updates lost, reconnecting' : 'Live updates back')
	}
	useFocusRescue()

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			// Cmd/Ctrl+S submits the FormSection the caret is in (requestSubmit, so its `required` inputs are checked
			// first); anywhere else it is swallowed so the browser never offers to save the page.
			if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
			event.preventDefault()
			if (event.target instanceof Element)
				event.target.closest<HTMLFormElement>('form[data-saves]')?.requestSubmit()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	const isOpen = (id: string) => !closed.includes(id)
	const setOpen = (id: string, open: boolean) =>
		setClosed(ids => (open ? ids.filter(closedId => closedId !== id) : [...ids, id]))

	return (
		<BaseTooltip.Provider delay={250} timeout={300}>
			<div className='grid h-dvh w-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-surface-sunken text-foreground md:grid-cols-[auto_minmax(0,1fr)]'>
				<a
					href='#content'
					className='sr-only z-70 rounded-control border bg-surface px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2'
				>
					Skip to content
				</a>
				<Sidebar
					label='Main'
					collapsed={collapsed}
					onCollapsedChange={setCollapsed}
					top={
						<>
							<Brand eventsLost={eventsLost} />
							<span
								aria-hidden='true'
								className='mx-1.5 h-[18px] w-px flex-none bg-border max-sm:hidden'
							/>
							{/* The page's breadcrumb and h1 land here, so a page owns what it is called without a bar of its own. */}
							<div ref={setHeader} className='flex min-w-0 flex-1 items-center' />
							<button
								type='button'
								aria-haspopup='dialog'
								aria-keyshortcuts='Meta+K Control+K'
								onClick={() => setSearchOpen(true)}
								className='flex h-8 flex-none items-center gap-2 rounded-[10px] bg-surface-muted px-2.5 text-muted transition-colors duration-110 ease-standard hover:text-foreground max-md:size-8 max-md:justify-center max-md:bg-transparent max-md:px-0 md:w-64'
							>
								<IconSearch size={16} aria-hidden='true' />
								<span className='max-md:sr-only'>Search</span>
								<kbd className='ml-auto rounded-[6px] border border-border-strong px-[5px] font-sans text-xs leading-4 max-md:hidden'>
									⌘K
								</kbd>
							</button>
							<DeploymentInbox />
							<Profile />
						</>
					}
				>
					<SidebarSection>
						{home.map(item => (
							<NavLink key={item.to} item={item} />
						))}
					</SidebarSection>
					<ProjectsSection open={isOpen('projects')} onOpenChange={open => setOpen('projects', open)} />
					<SidebarSection
						title='Docker'
						open={isOpen('docker')}
						onOpenChange={open => setOpen('docker', open)}
					>
						{docker.map(item => (
							<NavLink key={item.to} item={item} />
						))}
					</SidebarSection>
					<SidebarSection
						title='System'
						open={isOpen('system')}
						onOpenChange={open => setOpen('system', open)}
					>
						{system.map(item => (
							<NavLink key={item.to} item={item} />
						))}
					</SidebarSection>
				</Sidebar>
				<div className='relative isolate mx-2 mb-2 flex min-h-0 flex-col overflow-hidden rounded-panel border-[0.5px] border-border bg-background shadow-resting md:ml-0'>
					<PageChrome value={header}>{children}</PageChrome>
				</div>
				<p role='status' aria-live='polite' className='sr-only'>
					{announcement}
				</p>
				<CommandMenu
					open={searchOpen}
					onOpenChange={setSearchOpen}
					groups={[
						{
							label: 'Go to',
							pages: [...home, { to: '/projects', label: 'Projects', icon: IconFolder }, settings],
						},
						{ label: 'Docker', pages: docker },
						{ label: 'System', pages: system },
					]}
				/>
			</div>
		</BaseTooltip.Provider>
	)
}

function NavLink({ item }: { item: NavItem }) {
	const Icon = item.icon
	return (
		<SidebarLink to={item.to} exact={item.exact} label={item.label} icon={<Icon size={16} aria-hidden='true' />} />
	)
}

function ProjectsSection({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { projectId } = useParams({ strict: false })
	const environmentId = useEnvironmentId()
	const projects = useQuery(projectsQuery)

	return (
		<SidebarSection title='Projects' open={open} onOpenChange={onOpenChange}>
			<SidebarLink
				key='all'
				to='/projects'
				exact
				label='All projects'
				icon={<IconFolder size={16} aria-hidden='true' />}
				count={projects.data?.length}
			/>
			{projects.data?.map(project => (
				<SidebarLink
					key={project.id}
					to='/projects/$projectId'
					params={{ projectId: project.id }}
					// The environment is the project's own, so a link out of this project must drop the one in the URL
					// or the manager 404s it.
					search={{ env: project.id === projectId ? environmentId : undefined }}
					label={project.name}
					icon={<ProjectMark name={project.name} />}
					count={project.service_count}
				/>
			))}
			{projects.isPending ? (
				<SidebarItem key='loading'>
					<div className='flex h-(--row) items-center pl-2'>
						<Skeleton label='Loading projects' lines={1} className='w-24' />
					</div>
				</SidebarItem>
			) : null}
			{projects.isError ? (
				<SidebarItem key='error'>
					<div className='flex min-h-(--row) items-center justify-between gap-1 pl-2 text-xs text-danger'>
						<span className='truncate'>Could not load projects</span>
						<IconButton
							icon={IconRefresh}
							label='Load projects again'
							loading={projects.isFetching}
							onClick={() => projects.refetch()}
						/>
					</div>
				</SidebarItem>
			) : null}
		</SidebarSection>
	)
}

function ProjectMark({ name }: { name: string }) {
	return (
		<span className='grid size-4 place-items-center rounded-[5px] bg-[color-mix(in_oklab,var(--text-muted)_22%,transparent)] text-[10px] leading-none font-medium text-muted'>
			{name.slice(0, 1).toUpperCase()}
		</span>
	)
}

/** The mark where rarv has its org switcher; an update in flight or waiting, or a lost event stream, tints the version
 * beside it, and the row opens About. */
function Brand({ eventsLost }: { eventsLost: boolean }) {
	const version = useQuery({ ...versionQuery, refetchInterval: 60_000 })
	// The update state is a tiny file read; polling it keeps the bar honest
	// about an update started on another page (or by another session).
	const updateState = useQuery({ ...updateStateQuery, refetchInterval: 10_000 })
	// A failing fetch while the last known phase was active is the manager
	// being swapped, not an error.
	const updating = updateActive(updateState.data?.phase)
	const restarting = updating && updateState.isError

	let versionText = ''
	let brandLabel = `Vexdock ${version.data?.current ?? ''}`.trim()
	let versionClass: string | undefined
	if (updating) {
		versionText = restarting ? 'restarting…' : `updating → ${updateState.data?.target}`
		brandLabel = restarting ? 'Vexdock, restarting' : `Vexdock, updating to ${updateState.data?.target}`
		versionClass = 'text-warning'
	} else if (eventsLost) {
		versionText = 'reconnecting…'
		brandLabel = 'Vexdock, live updates lost, reconnecting'
		versionClass = 'text-warning'
	} else if (version.data?.update_available) {
		versionText = `${version.data.current} → ${version.data.latest}`
		brandLabel = `Vexdock ${version.data.current}, update to ${version.data.latest} available`
		versionClass = 'text-success'
	}

	return (
		<Link
			to='/system/settings/about'
			draggable={false}
			aria-label={brandLabel}
			className='flex h-8 max-w-60 min-w-0 flex-none items-center gap-2 rounded-[10px] pr-2 pl-1.5 hover:bg-(--row-hover) active:bg-(--row-active)'
		>
			<span aria-hidden='true' className='relative grid size-5 flex-none place-items-center text-foreground'>
				<Logo className='size-4' />
				{/* The phone hides the version line; the dot keeps its tone in view, the label says it. */}
				{versionClass ? (
					<span
						className={cn(
							'absolute -top-0.5 -right-0.5 size-2 rounded-full bg-current ring-2 ring-surface-sunken sm:hidden',
							versionClass,
						)}
					/>
				) : null}
			</span>
			<span className='truncate text-sm leading-[1.35] font-semibold max-sm:sr-only'>Vexdock</span>
			{/* The plain version lives in About; the row only speaks up for an update or a lost stream. */}
			{versionClass ? (
				<span className={cn('truncate text-xs max-sm:hidden', versionClass)}>{versionText}</span>
			) : null}
		</Link>
	)
}

/** rarv's user menu trigger: the avatar in a round button, its menu below it on the right. */
function Profile() {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const session = useSession()
	const logout = useMutation({
		mutationFn: async () => {
			const { error } = await signOut()
			if (error) throw new Error(error.message ?? 'Could not log out')
		},
		onSuccess: async () => {
			queryClient.clear()
			await navigate({ to: '/login', replace: true })
		},
	})
	const name = session.data?.user.name || 'Account'

	return (
		<>
			<DropdownMenu
				align='end'
				menuClassName='w-56'
				trigger={
					<button
						type='button'
						aria-label={logout.isError ? `Account menu, ${name}, log out failed` : `Account menu, ${name}`}
						className='relative inline-flex h-10 flex-none items-center gap-2 rounded-full p-1 text-sm transition-colors duration-110 ease-standard hover:bg-surface-muted active:bg-surface-pressed data-popup-open:bg-surface-muted'
					>
						<Avatar name={name} size='md' aria-hidden />
					</button>
				}
				items={[
					{ label: settings.label, icon: <IconSettings size={16} stroke={1.75} />, href: settings.to },
					{
						label: 'About',
						icon: <IconInfoCircle size={16} stroke={1.75} />,
						href: '/system/settings/about',
					},
					{
						label: logout.isError ? 'Log out failed, try again' : 'Log out',
						icon: <IconLogout size={16} stroke={1.75} />,
						separatorBefore: true,
						disabled: logout.isPending,
						onSelect: () => logout.mutate(),
					},
				]}
			/>
			{/* Mounted empty: the menu has closed by the time the request fails, so nothing else would say it. */}
			<p role='alert' className='sr-only'>
				{logout.isError ? 'Log out failed, try again' : ''}
			</p>
		</>
	)
}
