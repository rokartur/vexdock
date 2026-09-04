import { type CSSProperties, useEffect, useMemo, useState, type ReactNode } from 'react'
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
	IconLayoutSidebar,
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
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarRail,
	SidebarTrigger,
	useSidebar,
} from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/utils/cn'
import { api, updateActive } from '../lib/api'
import { signOut, useSession } from '../lib/auth-client'
import { useBrandColor } from '../lib/brand'
import { useSystemEvents } from '../lib/sse'
import { CommandPalette } from './command-palette'
import { Keys, mod } from './primitives'

type NavItem = { to: string; label: string; icon: TablerIcon; exact?: boolean }

const groups: { label: string; items: NavItem[] }[] = [
	{
		label: 'Home',
		items: [
			{ to: '/', label: 'Dashboard', icon: IconHome, exact: true },
			{ to: '/projects', label: 'Projects', icon: IconFolder },
			{ to: '/domains', label: 'Domains', icon: IconWorld },
			{ to: '/tasks', label: 'Tasks', icon: IconClock },
			{ to: '/analytics', label: 'Analytics', icon: IconChartBar },
		],
	},
	{
		label: 'Docker',
		items: [
			{ to: '/docker/containers', label: 'Containers', icon: IconBox },
			{ to: '/docker/images', label: 'Images', icon: IconStack2 },
			{ to: '/docker/volumes', label: 'Volumes', icon: IconDatabase },
			{ to: '/docker/networks', label: 'Networks', icon: IconAffiliate },
		],
	},
	{
		label: 'System',
		items: [
			{ to: '/system', label: 'Overview', icon: IconActivity, exact: true },
			{ to: '/system/certificates', label: 'Certificates', icon: IconCertificate },
			{ to: '/system/audit', label: 'Audit', icon: IconListDetails },
			{ to: '/system/docker', label: 'Cleanup', icon: IconTrash },
			{ to: '/system/backups', label: 'Backups', icon: IconArchive },
			{ to: '/system/settings', label: 'Settings', icon: IconSettings },
		],
	},
]

const HIDDEN_KEY = 'navigation-leftBarIsHidden'

/**
 * Read on the first render so no reload ever paints the rail open and then
 * hides it. Safe because the shell is client-only: the auth gate resolves a
 * session before it mounts, so this is never part of the prerendered markup.
 */
const storedHidden = () => typeof localStorage !== 'undefined' && localStorage.getItem(HIDDEN_KEY) === 'true'

/** One icon button in the rail's top row, its name and shortcut in the tooltip. */
function RailButton({
	icon: Icon,
	label,
	keys,
	onClick,
}: {
	icon: TablerIcon
	label: string
	keys: string[]
	onClick: () => void
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant='ghost'
						size='icon-sm'
						onClick={onClick}
						aria-label={label}
						className='text-muted-foreground hover:text-foreground'
					/>
				}
			>
				<Icon />
			</TooltipTrigger>
			<TooltipContent>
				{label}
				<Keys keys={keys} />
			</TooltipContent>
		</Tooltip>
	)
}

/** Search and hide, next to the workspace switcher. Inside the provider for `toggleSidebar`. */
function RailButtons({ onSearch }: { onSearch: () => void }) {
	const { toggleSidebar } = useSidebar()
	return (
		<div className='flex shrink-0 items-center'>
			<RailButton icon={IconSearch} label='Search' keys={[mod, 'K']} onClick={onSearch} />
			<RailButton icon={IconLayoutSidebar} label='Hide sidebar' keys={['[']} onClick={toggleSidebar} />
		</div>
	)
}

/** The rail plus the content panel it sits next to. Cmd/Ctrl+K opens the palette, `[` hides the rail. */
export function Shell({ children }: { children: ReactNode }) {
	const [paletteOpen, setPaletteOpen] = useState(false)
	const [isHidden, setIsHidden] = useState(storedHidden)
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const pathname = useRouterState({ select: state => state.location.pathname })

	useBrandColor()
	// The whole panel's refresh loop: docker and deployment events invalidate the
	// mounted queries, so pages do not poll for what the server can announce.
	useSystemEvents()
	const version = useQuery({ queryKey: ['version'], queryFn: api.version, refetchInterval: 60_000 })
	const updateAvailable = version.data?.update_available ?? false
	// The update state is a tiny file read; polling it keeps the rail honest
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

	let settingsDot: string | undefined
	let footerText = version.data?.current ?? 'dev'
	let footerClass = 'text-muted-foreground'
	if (updating) {
		settingsDot = 'bg-amber-400'
		footerText = restarting ? 'restarting…' : `updating → ${updateState.data?.target}`
		footerClass = 'text-amber-400'
	} else if (updateAvailable) {
		settingsDot = 'bg-emerald-400'
		footerText = `${version.data?.current} → ${version.data?.latest}`
		footerClass = 'text-emerald-400'
	}
	const session = useSession()

	const logout = useMutation({
		mutationFn: () => signOut(),
		onSuccess: async () => {
			queryClient.clear()
			await navigate({ to: '/login', replace: true })
		},
	})

	const setHidden = (hidden: boolean) => {
		localStorage.setItem(HIDDEN_KEY, String(hidden))
		setIsHidden(hidden)
	}

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
				return
			}
			const target = event.target as HTMLElement | null
			const typing =
				target?.isContentEditable ||
				['input', 'textarea', 'select'].includes(target?.tagName.toLowerCase() ?? '')
			if (event.key === '[' && !typing && !event.metaKey && !event.ctrlKey) {
				setIsHidden(hidden => {
					localStorage.setItem(HIDDEN_KEY, String(!hidden))
					return !hidden
				})
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	const links = useMemo(() => groups.flatMap(group => group.items), [])
	const email = session.data?.user.email ?? ''
	const name = session.data?.user.name || 'Account'
	const isActive = (item: NavItem) => (item.exact ? pathname === item.to : pathname.startsWith(item.to))

	return (
		<SidebarProvider
			open={!isHidden}
			onOpenChange={open => setHidden(!open)}
			className='h-dvh min-h-0 overflow-hidden'
			style={{ '--sidebar-width': '15rem' } as CSSProperties}
		>
			<Sidebar collapsible='offcanvas'>
				<SidebarHeader className='flex-row items-center gap-1 p-2'>
					<SidebarMenu className='min-w-0 flex-1'>
						<SidebarMenuItem>
							<DropdownMenu>
								<DropdownMenuTrigger render={<SidebarMenuButton className='h-8' />}>
									<Avatar className='size-5 rounded-sm'>
										<AvatarFallback className='rounded-sm bg-primary text-[10px] font-semibold text-primary-foreground'>
											VX
										</AvatarFallback>
									</Avatar>
									<span className='truncate font-medium'>vexdock</span>
									<IconSelector className='ml-auto size-3.5! text-muted-foreground' />
								</DropdownMenuTrigger>
								<DropdownMenuContent side='bottom' align='start' sideOffset={8} className='w-60'>
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
									{email ? (
										<div className='truncate px-2 py-1.5 text-label text-muted-foreground'>
											{email}
										</div>
									) : null}
									<DropdownMenuItem onClick={() => logout.mutate()}>
										<IconLogout />
										Log out
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</SidebarMenuItem>
					</SidebarMenu>
					<RailButtons onSearch={() => setPaletteOpen(true)} />
				</SidebarHeader>

				<SidebarContent>
					{groups.map(group => (
						<SidebarGroup key={group.label} className='py-1'>
							<SidebarGroupLabel className='h-7 text-label text-muted-foreground'>
								{group.label}
							</SidebarGroupLabel>
							<SidebarGroupContent>
								<SidebarMenu className='gap-px'>
									{group.items.map(item => (
										<SidebarMenuItem key={item.to}>
											<SidebarMenuButton
												isActive={isActive(item)}
												render={<Link to={item.to} draggable={false} />}
												className='h-7 text-body text-muted-foreground hover:text-foreground data-active:text-foreground'
											>
												<item.icon stroke={1.5} />
												<span>{item.label}</span>
											</SidebarMenuButton>
											{item.to === '/system/settings' && settingsDot ? (
												<SidebarMenuBadge className='top-1'>
													<span
														aria-hidden
														className={cn('size-1.5 rounded-full', settingsDot)}
													/>
												</SidebarMenuBadge>
											) : null}
										</SidebarMenuItem>
									))}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					))}
				</SidebarContent>

				<SidebarFooter className='gap-1 border-t p-2'>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton size='lg' render={<Link to='/system/settings' draggable={false} />}>
								<Avatar className='size-6 rounded-md'>
									<AvatarFallback className='rounded-md bg-secondary text-[10px] font-medium'>
										{(email || '?').slice(0, 2).toUpperCase()}
									</AvatarFallback>
								</Avatar>
								<span className='flex min-w-0 flex-1 flex-col leading-tight'>
									<span className='truncate text-body font-medium'>{name}</span>
									<span className='truncate text-label text-muted-foreground'>{email}</span>
								</span>
								<IconSettings className='text-muted-foreground' />
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
					<Link
						to='/system/settings/about'
						className={cn('text-center font-mono text-meta hover:text-foreground', footerClass)}
					>
						{footerText}
					</Link>
				</SidebarFooter>
				<SidebarRail />
			</Sidebar>

			<SidebarInset className='min-h-0 overflow-hidden'>
				{/* Below md the rail is a sheet, and this is the only way to open it. */}
				<SidebarTrigger className='absolute top-2 right-2 z-20 md:hidden' />
				{children}
			</SidebarInset>

			<CommandPalette links={links} open={paletteOpen} onOpenChange={setPaletteOpen} />
		</SidebarProvider>
	)
}
