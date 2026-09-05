import { useEffect, useMemo, useState, type ReactNode } from 'react'
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
	IconListDetails,
	IconLogout,
	IconSearch,
	IconSelector,
	IconSettings,
	IconStack2,
	IconTrash,
	IconWorld,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/utils/cn'
import { api, updateActive } from '../lib/api'
import { signOut, useSession } from '../lib/auth-client'
import { useBrandColor } from '../lib/brand'
import { useSystemEvents } from '../lib/sse'
import { CommandPalette } from './command-palette'
import { Button, Keys, mod, PageChrome } from './primitives'

type NavItem = { to: string; label: string; icon: TablerIcon; exact?: boolean }

const home: NavItem[] = [
	{ to: '/', label: 'Dashboard', icon: IconHome, exact: true },
	{ to: '/projects', label: 'Projects', icon: IconFolder },
	{ to: '/domains', label: 'Domains', icon: IconWorld },
	{ to: '/tasks', label: 'Tasks', icon: IconClock },
	{ to: '/analytics', label: 'Analytics', icon: IconChartBar },
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
	{ to: '/system/audit', label: 'Audit', icon: IconListDetails },
	{ to: '/system/docker', label: 'Cleanup', icon: IconTrash },
	{ to: '/system/backups', label: 'Backups', icon: IconArchive },
	{ to: '/system/settings', label: 'Settings', icon: IconSettings },
]

const groups = [
	{ label: 'Home', items: home },
	{ label: 'Docker', items: docker },
	{ label: 'System', items: system },
]

/**
 * The section bar at the top level. Docker and System are whole sections, so
 * they enter at their first page and the bar becomes their own pages from
 * there; the breadcrumb and the workspace menu are the way back out.
 */
const topLevel: NavItem[] = [
	...home,
	{ to: '/docker/containers', label: 'Docker', icon: IconBox },
	{ to: '/system', label: 'System', icon: IconActivity },
]

function sectionOf(pathname: string) {
	if (pathname.startsWith('/docker')) return docker
	if (pathname.startsWith('/system')) return system
	return topLevel
}

const isActive = (item: NavItem, pathname: string) => (item.exact ? pathname === item.to : pathname.startsWith(item.to))

/** One section link: the rail's pill, laid on its side. */
function SectionLink({ item, active }: { item: NavItem; active: boolean }) {
	return (
		<Link
			to={item.to}
			draggable={false}
			aria-current={active ? 'page' : undefined}
			className={cn(
				'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-body whitespace-nowrap transition-colors',
				active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
			)}
		>
			<item.icon stroke={1.5} className='size-4' />
			{item.label}
		</Link>
	)
}

/**
 * The panel's chrome: a workspace bar carrying the page's own breadcrumb and
 * actions, and a section bar under it. A page with sub-navigation of its own
 * takes that second bar over, so there is only ever one row of tabs on screen.
 * Cmd/Ctrl+K opens the palette, which is what reaches everything else.
 */
export function Shell({ children }: { children: ReactNode }) {
	const [paletteOpen, setPaletteOpen] = useState(false)
	// Set from the refs during commit, so the page's chrome lands in these bars
	// before the first paint rather than a frame later.
	const [header, setHeader] = useState<HTMLElement | null>(null)
	const [toolbar, setToolbar] = useState<HTMLElement | null>(null)
	const chrome = useMemo(() => (header && toolbar ? { header, toolbar } : null), [header, toolbar])
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const pathname = useRouterState({ select: state => state.location.pathname })

	useBrandColor()
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
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault()
				setPaletteOpen(open => !open)
				return
			}
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

	const links = useMemo(() => groups.flatMap(group => group.items), [])
	const email = session.data?.user.email ?? ''
	const name = session.data?.user.name || 'Account'

	return (
		<div className='flex h-dvh min-h-0 flex-col overflow-hidden'>
			<header className='flex h-12 shrink-0 items-center gap-2 border-b px-3'>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<button
								type='button'
								aria-label='Navigation'
								className='flex h-8 shrink-0 items-center gap-2 rounded-md px-1.5 text-body hover:bg-muted'
							/>
						}
					>
						<Avatar className='size-5 rounded-sm'>
							<AvatarFallback className='rounded-sm bg-primary text-[10px] font-semibold text-primary-foreground'>
								VX
							</AvatarFallback>
						</Avatar>
						<span className='font-medium'>vexdock</span>
						{updateDot ? <span aria-hidden className={cn('size-1.5 rounded-full', updateDot)} /> : null}
						<IconSelector className='size-3.5! text-muted-foreground' />
					</DropdownMenuTrigger>
					<DropdownMenuContent side='bottom' align='start' sideOffset={8} className='w-56'>
						{groups.map(group => (
							<DropdownMenuGroup key={group.label}>
								<DropdownMenuLabel className='text-label text-muted-foreground'>
									{group.label}
								</DropdownMenuLabel>
								{group.items.map(item => (
									<DropdownMenuItem key={item.to} render={<Link to={item.to} />}>
										<item.icon />
										{item.label}
									</DropdownMenuItem>
								))}
							</DropdownMenuGroup>
						))}
						<DropdownMenuSeparator />
						<DropdownMenuItem render={<Link to='/system/settings/about' />}>
							<span className={cn('font-mono text-meta', versionClass)}>{versionText}</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<span aria-hidden className='shrink-0 text-muted-foreground/60'>
					/
				</span>
				{/* The page's breadcrumb and actions land here, so a page owns what it
				    is called without owning a bar of its own. */}
				<div ref={setHeader} className='flex min-w-0 flex-1 items-center gap-3 overflow-hidden' />
				<Button variant='ghost' onClick={() => setPaletteOpen(true)}>
					<IconSearch />
					<span className='hidden sm:inline'>Search</span>
					<Keys keys={[mod, 'K']} />
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<button
								type='button'
								aria-label='Account'
								className='shrink-0 rounded-md p-1 hover:bg-muted'
							/>
						}
					>
						<Avatar className='size-6 rounded-md'>
							<AvatarFallback className='rounded-md bg-secondary text-[10px] font-medium'>
								{(email || '?').slice(0, 2).toUpperCase()}
							</AvatarFallback>
						</Avatar>
					</DropdownMenuTrigger>
					<DropdownMenuContent side='bottom' align='end' sideOffset={8} className='w-60'>
						<div className='px-2 py-1.5'>
							<div className='truncate text-body font-medium'>{name}</div>
							{email ? <div className='truncate text-label text-muted-foreground'>{email}</div> : null}
						</div>
						<DropdownMenuSeparator />
						<DropdownMenuItem render={<Link to='/system/settings' />}>
							<IconSettings />
							Settings
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => setPaletteOpen(true)}>
							<IconSearch />
							Jump to
							<DropdownMenuShortcut className='tracking-normal'>
								<Keys keys={[mod, 'K']} />
							</DropdownMenuShortcut>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={() => logout.mutate()}>
							<IconLogout />
							Log out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</header>

			<div className='flex h-10 shrink-0 items-center gap-4 border-b px-3'>
				{/* Hidden while the page fills the slot next to it: a page's own tabs
				    replace its section's, the way the breadcrumb replaces its trail. */}
				<nav className='flex min-w-0 items-center gap-0.5 overflow-x-auto [&:has(~div:not(:empty))]:hidden'>
					{sectionOf(pathname).map(item => (
						<SectionLink key={item.to} item={item} active={isActive(item, pathname)} />
					))}
				</nav>
				<div ref={setToolbar} className='contents' />
			</div>

			<PageChrome value={chrome}>{children}</PageChrome>

			<CommandPalette links={links} open={paletteOpen} onOpenChange={setPaletteOpen} />
		</div>
	)
}
