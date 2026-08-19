import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
	IconActivity,
	IconAffiliate,
	IconArchive,
	IconBox,
	IconCertificate,
	IconChevronDown,
	IconDatabase,
	IconFolder,
	IconHome,
	IconLayoutSidebar,
	IconListDetails,
	IconSearch,
	IconSettings,
	IconStack2,
	IconTrash,
	IconWorld,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/utils/cn'
import { api } from '../lib/api'
import { signOut, useSession } from '../lib/auth-client'
import { CommandPalette } from './command-palette'
import { NavigationSidebar } from './navigation-sidebar'

type NavItem = { to: string; label: string; icon: TablerIcon; exact?: boolean }

const groups: { label: string; items: NavItem[] }[] = [
	{
		label: 'Home',
		items: [
			{ to: '/', label: 'Dashboard', icon: IconHome, exact: true },
			{ to: '/projects', label: 'Projects', icon: IconFolder },
			{ to: '/domains', label: 'Domains', icon: IconWorld },
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

/** Read on the first render for the same reason as the rail's width. */
const storedHidden = () => typeof localStorage !== 'undefined' && localStorage.getItem(HIDDEN_KEY) === 'true'

const linkClass =
	'group flex h-7.5 items-center gap-2.5 rounded-lg border border-transparent px-2 text-title text-muted-foreground hover:bg-accent hover:text-foreground data-[status=active]:border-border data-[status=active]:bg-sidebar-accent data-[status=active]:text-foreground'

function NavigationLink({ to, label, exact, icon: Icon, dot }: NavItem & { dot?: boolean }) {
	return (
		<Link draggable={false} to={to} activeOptions={{ exact: exact ?? false }} className={linkClass}>
			<Icon
				stroke={1.5}
				className='size-4 shrink-0 text-muted-foreground group-hover:text-foreground group-data-[status=active]:text-foreground'
			/>
			<span className='truncate'>{label}</span>
			{dot ? <span className='ml-auto size-1.5 shrink-0 rounded-full bg-emerald-400' aria-hidden /> : null}
		</Link>
	)
}

/** The rail plus the content panel it sits next to. Cmd/Ctrl+K opens the palette, `[` hides the rail. */
export function Shell({ children }: { children: ReactNode }) {
	const [paletteOpen, setPaletteOpen] = useState(false)
	const [isHidden, setIsHidden] = useState(storedHidden)
	const [showTemporary, setShowTemporary] = useState(false)
	const navigate = useNavigate()
	const queryClient = useQueryClient()

	const version = useQuery({ queryKey: ['version'], queryFn: api.version, refetchInterval: 60_000 })
	const updateAvailable = version.data?.update_available ?? false
	const session = useSession()

	const logout = useMutation({
		mutationFn: () => signOut(),
		onSuccess: async () => {
			queryClient.clear()
			await navigate({ to: '/login', replace: true })
		},
	})

	const toggleHidden = () => {
		setIsHidden(hidden => {
			localStorage.setItem(HIDDEN_KEY, String(!hidden))
			return !hidden
		})
		setShowTemporary(false)
	}

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault()
				setPaletteOpen(open => !open)
				return
			}
			// Sections handle Cmd/Ctrl+S themselves; swallow the rest so the browser
			// never offers to save the page.
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
				event.preventDefault()
				return
			}
			const target = event.target as HTMLElement | null
			const typing =
				target?.isContentEditable ||
				['input', 'textarea', 'select'].includes(target?.tagName.toLowerCase() ?? '')
			if (event.key === '[' && !typing && !event.metaKey && !event.ctrlKey) toggleHidden()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	const links = useMemo(() => groups.flatMap(group => group.items), [])
	const email = session.data?.user.email ?? ''
	const name = session.data?.user.name || 'Account'

	return (
		// The rail's colour is also the canvas the content panel floats on.
		<div className='flex h-dvh w-full overflow-hidden bg-sidebar'>
			<NavigationSidebar
				isHidden={isHidden}
				showTemporary={showTemporary}
				onShowTemporaryChange={setShowTemporary}
			>
				<div className='flex min-w-0 items-center gap-2'>
					<div className='min-w-0 flex-1'>
						<DropdownMenu>
							<DropdownMenuTrigger className='flex h-7 max-w-full min-w-0 items-center gap-2 rounded-lg pr-2 pl-1 text-left hover:bg-accent'>
								<Avatar className='size-5 rounded-md'>
									<AvatarFallback className='rounded-md bg-secondary text-[10px] font-normal text-foreground'>
										PL
									</AvatarFallback>
								</Avatar>
								<span className='min-w-0 flex-1 truncate text-sm font-normal text-foreground'>
									platform
								</span>
								<IconChevronDown className='size-3 shrink-0 text-muted-foreground' />
							</DropdownMenuTrigger>
							<DropdownMenuContent side='bottom' align='start' sideOffset={8} className='w-64'>
								<DropdownMenuItem render={<Link to='/system/settings' />}>Settings</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setPaletteOpen(true)}>
									Jump to
									<DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								{email ? (
									<div className='truncate px-2 py-1.5 text-xs text-muted-foreground'>{email}</div>
								) : null}
								<DropdownMenuItem onClick={() => logout.mutate()}>Log out</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>

					<div className='flex shrink-0 items-center gap-0.5'>
						<button
							type='button'
							onClick={() => setPaletteOpen(true)}
							className='flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground'
							aria-label='Search'
						>
							<IconSearch className='size-4' />
						</button>
						<button
							type='button'
							onClick={toggleHidden}
							className='flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground'
							aria-label={isHidden ? 'Show sidebar' : 'Hide sidebar'}
						>
							<IconLayoutSidebar className='size-4' />
						</button>
					</div>
				</div>

				<div className='flex flex-1 flex-col gap-4 overflow-y-auto'>
					{groups.map(group => (
						<div key={group.label} className='flex flex-col gap-1'>
							<span className='px-2 text-label text-muted-foreground'>{group.label}</span>
							<div className='flex flex-col gap-0.5'>
								{group.items.map(item => (
									<NavigationLink
										key={item.to}
										{...item}
										dot={updateAvailable && item.to === '/system/settings'}
									/>
								))}
							</div>
						</div>
					))}
				</div>

				<div className='flex flex-col gap-1 border-t border-sidebar-border pt-2'>
					<Link
						draggable={false}
						to='/system/settings'
						className='group flex h-10 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-accent'
					>
						<Avatar className='size-6'>
							<AvatarFallback className='bg-secondary text-[10px] font-normal text-foreground'>
								{(email || '?').slice(0, 2).toUpperCase()}
							</AvatarFallback>
						</Avatar>
						<div className='min-w-0 flex-1'>
							<div className='truncate text-body font-medium text-foreground'>{name}</div>
							<div className='truncate text-label text-muted-foreground'>{email}</div>
						</div>
						<IconSettings className='size-3.5 shrink-0 text-muted-foreground group-hover:text-muted-foreground' />
					</Link>
					<Link
						to='/system/settings/about'
						className={cn(
							'text-center font-mono text-meta',
							updateAvailable
								? 'text-emerald-400 hover:text-emerald-300'
								: 'text-muted-foreground hover:text-muted-foreground',
						)}
					>
						{version.data?.current ?? 'dev'}
						{updateAvailable ? ` → ${version.data?.latest}` : ''}
					</Link>
				</div>
			</NavigationSidebar>

			<main className='m-2 ml-0 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-background'>
				{children}
			</main>

			<CommandPalette links={links} open={paletteOpen} onOpenChange={setPaletteOpen} />
		</div>
	)
}
