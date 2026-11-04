import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type ReactElement,
	type ReactNode,
	type RefObject,
} from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import {
	IconActivity,
	IconAffiliate,
	IconArchive,
	IconBox,
	IconBrandDocker,
	IconCertificate,
	IconChartBar,
	IconChevronRight,
	IconClock,
	IconDatabase,
	IconDots,
	IconFolder,
	IconHome,
	IconInfoCircle,
	IconLogout,
	IconSearch,
	IconSettings,
	IconStack2,
	IconTrash,
	IconX,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import { cn } from 'cn'
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform, type Transition } from 'motion/react'
import { Avatar } from '@/components/ui/avatar'
import { DropdownMenu } from '@/components/ui/dropdown-menu'
import { Tooltip } from '@/components/ui/tooltip'
import { api, updateActive } from '../lib/api'
import { signOut, useSession } from '../lib/auth-client'
import { useEnvironmentId } from '../lib/environment'
import { motionTokens } from '../lib/motion'
import { useSystemEvents } from '../lib/sse'
import { CommandMenu } from './command-menu'
import { DeploymentInbox } from './deployment-inbox'
import { Logo } from './logo'
import { ActivePill, Keys, mod, PageChrome, Tabs } from './primitives'

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

const isActive = (item: NavItem, pathname: string) => (item.exact ? pathname === item.to : pathname.startsWith(item.to))

// What the phone's tab bar leaves to the More sheet, and the groups that get a section strip instead.
const moreGroups = [
	{ heading: 'Home', items: home.filter(item => item.to !== '/') },
	{ heading: 'System', items: [...system, settings] },
]
const sectionGroups = [
	{ base: '/docker', items: docker },
	{ base: '/system', items: system },
]

const none: Transition = { duration: 0 }
const standardEase = motionTokens.ease.standard
const enterEase = motionTokens.ease.enter

// Text leaves fast on collapse and returns after the rail has started to widen.
function labelTransition(collapsed: boolean, instant: boolean): Transition {
	if (instant) return none
	return collapsed
		? { duration: 0.1, ease: standardEase }
		: { duration: motionTokens.duration.standard, delay: 0.07, ease: enterEase }
}

// The section divider arrives once the rail has narrowed.
function railMarkTransition(collapsed: boolean, instant: boolean): Transition {
	if (instant) return none
	return collapsed ? { duration: 0.14, delay: 0.11, ease: enterEase } : { duration: 0.07, ease: standardEase }
}

const iconButton =
	'inline-grid size-control-md flex-none place-items-center rounded-control text-secondary transition-colors duration-110 ease-standard [-webkit-tap-highlight-color:transparent] hover:bg-surface-muted hover:text-foreground active:bg-[color-mix(in_oklab,var(--foreground)_9%,transparent)] active:text-foreground pointer-coarse:size-10 motion-reduce:transition-none'

// workspace-sidebar's toggleClass, pinned to the search row's right edge so the 64 wide rail keeps it centred.
const railToggle =
	'absolute top-1/2 right-1 -mt-4 grid size-8 place-items-center rounded-[8px] text-secondary [-webkit-tap-highlight-color:transparent] hover:bg-(--row-hover) hover:text-foreground active:bg-(--row-active) active:text-foreground pointer-coarse:-mt-5 pointer-coarse:size-10'

const scrim =
	'absolute inset-0 bg-[color-mix(in_oklab,var(--foreground)_30%,transparent)] [-webkit-tap-highlight-color:transparent] dark:bg-background/50'

/** Arc's sidebar-rail on the real routes: 240 wide, a 64 wide rail on `[` or below 760, floating below 640, and below
 * 480 a bottom tab bar whose More opens a sheet. */
export function Shell({ children }: { children: ReactNode }) {
	const baseId = useId()
	const reduce = useReducedMotion() ?? false
	const [booting, setBooting] = useState(true)
	const instant = reduce || booting
	const [collapsed, setCollapsed] = useState(false)
	const [tablet, setTablet] = useState(false)
	const [projectsOpen, setProjectsOpen] = useState(true)
	const [moreOpen, setMoreOpen] = useState(false)
	const [searchOpen, setSearchOpen] = useState(false)
	const [shell, setShell] = useState<HTMLElement | null>(null)
	const [announcement, setAnnouncement] = useState('')
	// Set from the ref during commit, so the page's breadcrumb lands in the bar
	// before the first paint rather than a frame later.
	const [header, setHeader] = useState<HTMLElement | null>(null)
	const sheetRef = useRef<HTMLDivElement>(null)
	const sheetActions = useRef<Dialog.Root.Actions>(null)
	const moreButtonRef = useRef<HTMLButtonElement>(null)
	const sheetDragging = useRef(false)
	const closeTimer = useRef(0)
	const wasWide = useRef<boolean | null>(null)
	const sidebarId = `${baseId}-sidebar`
	const floating = tablet && !collapsed

	// The whole panel's refresh loop: docker and deployment events invalidate the
	// mounted queries, so pages do not poll for what the server can announce.
	useSystemEvents()

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			// Cmd/Ctrl+S submits the FormSection the caret is in (requestSubmit, so
			// its `required` inputs are checked first); anywhere else it is swallowed
			// so the browser never offers to save the page.
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
				event.preventDefault()
				if (event.target instanceof Element)
					event.target.closest<HTMLFormElement>('form[data-saves]')?.requestSubmit()
				return
			}
			if (event.key !== '[' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
			const { target } = event
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))
			)
				return
			if (!shell) return
			event.preventDefault()
			if (shell.clientWidth < 480) {
				if (moreOpen) sheetActions.current?.close()
				else setMoreOpen(true)
				return
			}
			setCollapsed(!collapsed)
			setAnnouncement(collapsed ? 'Sidebar expanded' : 'Sidebar collapsed')
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [shell, collapsed, moreOpen])

	useLayoutEffect(() => {
		if (!shell) return
		const shellElement = shell
		function fit() {
			const width = shellElement.clientWidth
			if (width >= 480) setMoreOpen(false)
			const isTablet = width >= 480 && width < 640
			setTablet(isTablet)
			const wide = width >= 760
			if (wasWide.current !== wide) {
				wasWide.current = wide
				setCollapsed(!wide)
			} else if (isTablet) {
				setCollapsed(true)
			}
		}
		fit()
		const frame = requestAnimationFrame(() => setBooting(false))
		const observer = new ResizeObserver(fit)
		observer.observe(shellElement)
		return () => {
			observer.disconnect()
			cancelAnimationFrame(frame)
		}
	}, [shell])

	useEffect(() => () => window.clearTimeout(closeTimer.current), [])

	function toggleRail() {
		setCollapsed(!collapsed)
		setAnnouncement(collapsed ? 'Sidebar expanded' : 'Sidebar collapsed')
	}

	function collapseRail() {
		setCollapsed(true)
		setAnnouncement('Sidebar collapsed')
	}

	function navigated(fromSheet: boolean) {
		if (!fromSheet && !floating) return
		window.clearTimeout(closeTimer.current)
		closeTimer.current = window.setTimeout(
			() => (fromSheet ? sheetActions.current?.close() : setCollapsed(true)),
			instant ? 0 : 140,
		)
	}

	function toggleProjects() {
		if (collapsed) {
			setCollapsed(false)
			setProjectsOpen(true)
			setAnnouncement('Sidebar expanded')
			return
		}
		setProjectsOpen(!projectsOpen)
	}

	const sheetY = useMotionValue<string | number>('100%')
	const sheetShown = useTransform(sheetY, y => {
		const height = sheetRef.current?.offsetHeight || 400
		const offset =
			typeof y === 'number'
				? y / height
				: y.endsWith('%')
					? Number(y.slice(0, -1)) / 100
					: Number(y.replace('px', '')) / height
		return Math.min(1, Math.max(0, 1 - (Number.isFinite(offset) ? offset : 1)))
	})
	const panelSpring = instant ? none : motionTokens.spring.smooth

	return (
		<BaseTooltip.Provider delay={250} timeout={300}>
			<div
				ref={setShell}
				className='@container/shell relative isolate flex h-dvh min-h-0 min-w-0 overflow-hidden bg-background text-foreground [--rail:color-mix(in_oklab,var(--surface-muted)_55%,var(--surface))] [--row-active:color-mix(in_oklab,var(--foreground)_7%,transparent)] [--row-hover:color-mix(in_oklab,var(--foreground)_4.5%,transparent)] motion-reduce:**:transition-none dark:[--rail:color-mix(in_oklab,var(--background)_60%,var(--surface))] dark:[--row-active:color-mix(in_oklab,var(--foreground)_8%,transparent)] dark:[--row-hover:color-mix(in_oklab,var(--foreground)_5%,transparent)]'
				onKeyDown={event => {
					if (event.key !== 'Escape' || !floating || event.defaultPrevented) return
					event.preventDefault()
					collapseRail()
				}}
			>
				<motion.div
					className='relative z-3 h-full flex-none @max-[480px]/shell:hidden'
					initial={false}
					animate={{ width: tablet || collapsed ? 64 : 240 }}
					transition={panelSpring}
				>
					<motion.div
						id={sidebarId}
						className='absolute inset-y-0 left-0 flex min-w-0 flex-col overflow-hidden bg-(--rail) transition-shadow duration-170 ease-standard after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border data-floating:shadow-floating motion-reduce:transition-none'
						initial={false}
						animate={{ width: collapsed ? 64 : 240 }}
						transition={panelSpring}
						data-collapsed={collapsed || undefined}
						data-floating={floating || undefined}
					>
						<Brand collapsed={collapsed} instant={instant} />
						<SearchRow collapsed={collapsed} instant={instant} onSearch={() => setSearchOpen(true)}>
							<Tooltip
								side={collapsed ? 'right' : 'bottom'}
								content={
									<span className='inline-flex items-center gap-2.5 whitespace-nowrap'>
										{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
										<kbd className='inline-grid h-5 min-w-5 place-items-center rounded-[6px] border border-[color-mix(in_oklab,var(--background)_30%,var(--foreground))] px-[5px] font-sans text-xs/none'>
											[
										</kbd>
									</span>
								}
							>
								<button
									type='button'
									className={railToggle}
									aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
									aria-expanded={!collapsed}
									aria-controls={sidebarId}
									aria-keyshortcuts='['
									onClick={toggleRail}
								>
									<PaneIcon collapsed={collapsed} instant={instant} />
								</button>
							</Tooltip>
						</SearchRow>
						<SidebarNav
							baseId={baseId}
							collapsed={collapsed}
							projectsOpen={projectsOpen}
							instant={instant}
							onNavigate={() => navigated(false)}
							onProjects={toggleProjects}
						/>
						<Profile collapsed={collapsed} instant={instant} />
					</motion.div>
				</motion.div>
				<AnimatePresence>
					{floating && (
						<motion.div
							key='float-scrim'
							className={cn(scrim, 'z-2')}
							aria-hidden='true'
							onClick={collapseRail}
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={
								instant ? none : { duration: motionTokens.duration.standard, ease: standardEase }
							}
						/>
					)}
				</AnimatePresence>
				<div className='relative isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
					<header className='flex min-h-13 flex-none items-center gap-3 px-6 pt-6 @max-[480px]/shell:gap-1 @max-[480px]/shell:px-4 @max-[480px]/shell:pt-[max(0.75rem,env(safe-area-inset-top,0px))]'>
						{/* The page's breadcrumb, title and actions land here, so a page owns what it
						    is called without owning a bar of its own. */}
						<div ref={setHeader} className='flex min-w-0 flex-1 items-center gap-3 overflow-hidden' />
						<DeploymentInbox />
					</header>
					<SectionStrip />
					<PageChrome value={header}>{children}</PageChrome>
					<TabBar
						moreOpen={moreOpen}
						moreButtonRef={moreButtonRef}
						onSearch={() => setSearchOpen(true)}
						onMore={() => setMoreOpen(true)}
					/>
					<p role='status' aria-live='polite' className='sr-only'>
						{announcement}
					</p>
				</div>
				<Dialog.Root
					open={moreOpen}
					actionsRef={sheetActions}
					onOpenChange={(open, eventDetails) => {
						// Base UI would hide the popup at once; motion's exit slide ends the closing phase instead.
						if (!open && !instant) eventDetails.preventUnmountOnClose()
						setMoreOpen(open)
					}}
					onOpenChangeComplete={open => {
						if (open) return
						// A held closing phase skips Base UI's focus return; the More tab takes it a frame later, once the shell is no longer inert.
						const focusWasInSheet =
							document.activeElement === document.body || document.activeElement?.closest('[role=dialog]')
						if (focusWasInSheet)
							requestAnimationFrame(() => moreButtonRef.current?.focus({ preventScroll: true }))
					}}
				>
					<AnimatePresence onExitComplete={() => sheetActions.current?.unmount()}>
						{moreOpen && shell && (
							<Dialog.Portal keepMounted container={shell}>
								<Dialog.Backdrop
									render={
										<motion.div className={cn(scrim, 'z-20')} style={{ opacity: sheetShown }} />
									}
								/>
								<Dialog.Popup
									ref={sheetRef}
									initialFocus={() =>
										sheetRef.current?.querySelector<HTMLElement>("[aria-current='page']") ?? true
									}
									finalFocus={() => {
										moreButtonRef.current?.focus({ preventScroll: true })
										return false
									}}
									render={
										<motion.div
											className='absolute inset-x-0 bottom-0 z-21 flex max-h-[calc(100%-40px)] touch-none flex-col overscroll-contain rounded-t-[16px] border-t border-border bg-(--rail) pr-[env(safe-area-inset-right,0)] pb-[env(safe-area-inset-bottom,0)] pl-[env(safe-area-inset-left,0)] shadow-floating'
											style={{ y: sheetY }}
											initial={{ y: '100%' }}
											animate={{ y: 0 }}
											exit={{ y: '100%' }}
											transition={panelSpring}
											drag={!reduce && 'y'}
											dragConstraints={{ top: 0, bottom: 0 }}
											dragElastic={{ top: 0.04, bottom: 0.9 }}
											dragMomentum={false}
											onDragStart={() => {
												sheetDragging.current = true
												sheetRef.current?.toggleAttribute('data-dragging', true)
											}}
											onDragEnd={(_, info) => {
												sheetRef.current?.toggleAttribute('data-dragging', false)
												// The click that ends a drag fires after dragend; let it see the drag first.
												window.setTimeout(() => {
													sheetDragging.current = false
												}, 0)
												if (info.offset.y > 72 || info.velocity.y > 480)
													sheetActions.current?.close()
											}}
										/>
									}
								>
									<Dialog.Title className='sr-only'>More</Dialog.Title>
									<span
										aria-hidden='true'
										className='mx-auto mt-2 h-1 w-9 flex-none rounded-full bg-border-strong'
									/>
									<div className='flex flex-none items-center pr-3'>
										<Brand collapsed={false} instant={instant} className='flex-1' />
										<Dialog.Close
											render={<button type='button' className={iconButton} aria-label='Close' />}
										>
											<IconX size={18} stroke={1.75} aria-hidden='true' />
										</Dialog.Close>
									</div>
									<MoreNav
										onNavigate={() => {
											if (!sheetDragging.current) navigated(true)
										}}
									/>
								</Dialog.Popup>
							</Dialog.Portal>
						)}
					</AnimatePresence>
				</Dialog.Root>
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

/** workspace-sidebar's search row: a field-shaped button that opens the command menu, faded out in the rail. */
function SearchRow({
	collapsed,
	instant,
	onSearch,
	children,
}: {
	collapsed: boolean
	instant: boolean
	onSearch: () => void
	children?: ReactNode
}) {
	return (
		<div className='relative mx-3 mb-2 flex h-10 flex-none items-center'>
			<motion.button
				type='button'
				inert={collapsed}
				aria-keyshortcuts='Meta+K'
				className={cn(
					'flex h-8 w-full min-w-0 items-center gap-2 rounded-[8px] border border-border bg-surface pr-1.5 pl-2.5 text-left text-[13px] whitespace-nowrap text-muted transition-colors duration-110 ease-standard hover:border-border-strong hover:text-secondary motion-reduce:transition-none pointer-coarse:h-10',
					children && 'mr-10',
				)}
				initial={false}
				animate={{ opacity: collapsed ? 0 : 1 }}
				transition={labelTransition(collapsed, instant)}
				onClick={onSearch}
			>
				<IconSearch size={16} stroke={1.75} aria-hidden='true' className='flex-none' />
				<span className='flex-1'>Search</span>
				<Keys keys={[mod, 'K']} />
			</motion.button>
			{children}
		</div>
	)
}

const tabItem =
	'press flex h-14 min-w-0 flex-col items-center justify-center gap-1 text-[11px]/none font-medium text-muted [-webkit-tap-highlight-color:transparent] data-lit:text-foreground'

/** The rail below 480: three destinations, the command menu and the More sheet, under the thumb. */
function TabBar({
	moreOpen,
	moreButtonRef,
	onSearch,
	onMore,
}: {
	moreOpen: boolean
	moreButtonRef: RefObject<HTMLButtonElement | null>
	onSearch: () => void
	onMore: () => void
}) {
	const pathname = useRouterState({ select: state => state.location.pathname })
	let lit: 'home' | 'projects' | 'docker' | 'more' = 'more'
	if (pathname === '/') lit = 'home'
	else if (pathname.startsWith('/projects')) lit = 'projects'
	else if (pathname.startsWith('/docker')) lit = 'docker'

	return (
		<nav
			aria-label='Tabs'
			className='hidden h-(--tab-bar) flex-none grid-cols-5 border-t border-border bg-(--rail) pb-[env(safe-area-inset-bottom,0px)] @max-[480px]/shell:grid'
		>
			<Link
				to='/'
				draggable={false}
				className={tabItem}
				data-lit={lit === 'home' || undefined}
				aria-current={lit === 'home' ? 'page' : undefined}
			>
				<TabFace icon={IconHome} label='Dashboard' lit={lit === 'home'} />
			</Link>
			<Link
				to='/projects'
				draggable={false}
				className={tabItem}
				data-lit={lit === 'projects' || undefined}
				aria-current={pathname === '/projects' ? 'page' : undefined}
			>
				<TabFace icon={IconFolder} label='Projects' lit={lit === 'projects'} />
			</Link>
			<Link
				to='/docker/containers'
				search={{ q: undefined }}
				draggable={false}
				className={tabItem}
				data-lit={lit === 'docker' || undefined}
				aria-current={pathname === '/docker/containers' ? 'page' : undefined}
			>
				<TabFace icon={IconBrandDocker} label='Docker' lit={lit === 'docker'} />
			</Link>
			<button type='button' className={tabItem} aria-keyshortcuts='Meta+K' onClick={onSearch}>
				<TabFace icon={IconSearch} label='Search' lit={false} />
			</button>
			<button
				ref={moreButtonRef}
				type='button'
				className={tabItem}
				data-lit={lit === 'more' || undefined}
				aria-haspopup='dialog'
				aria-expanded={moreOpen}
				aria-keyshortcuts='['
				onClick={onMore}
			>
				<TabFace icon={IconDots} label='More' lit={lit === 'more'} />
			</button>
		</nav>
	)
}

function TabFace({ icon: TabIcon, label, lit }: { icon: TablerIcon; label: string; lit: boolean }) {
	return (
		<>
			<span className='relative isolate grid h-7 w-14 place-items-center rounded-full'>
				{lit ? <ActivePill layoutId='tab-bar' className='bg-(--row-active)' /> : null}
				<TabIcon size={22} stroke={1.75} aria-hidden='true' className={lit ? 'text-accent' : undefined} />
			</span>
			<span className='max-w-full truncate px-1'>{label}</span>
		</>
	)
}

/** Below 480 the rail's Docker and System groups become a tab strip on the pages they hold. */
function SectionStrip() {
	const pathname = useRouterState({ select: state => state.location.pathname })
	const group = sectionGroups.find(section => section.items.some(item => isActive(item, pathname)))
	if (!group) return null
	return (
		<div className='hidden flex-none border-b px-4 pb-2 @max-[480px]/shell:block'>
			<Tabs
				base={group.base}
				tabs={group.items.map(item => ({ suffix: item.to.slice(group.base.length), label: item.label }))}
			/>
		</div>
	)
}

/** The More sheet's body: what the tab bar has no room for, as tiles, then the account. */
function MoreNav({ onNavigate }: { onNavigate: () => void }) {
	const pathname = useRouterState({ select: state => state.location.pathname })
	return (
		<>
			<nav aria-label='More' className='grid gap-3 px-3 pb-3'>
				{moreGroups.map(group => (
					<section key={group.heading} aria-label={group.heading}>
						<h2 className='px-1 pb-1.5 text-xs/none font-medium text-muted'>{group.heading}</h2>
						<ul role='list' className='grid grid-cols-4 gap-1.5'>
							{group.items.map(item => {
								const current = isActive(item, pathname)
								return (
									<li key={item.to}>
										<Link
											to={item.to}
											draggable={false}
											onClick={onNavigate}
											aria-current={current ? 'page' : undefined}
											className='flex h-18 press flex-col items-center justify-center gap-1.5 rounded-[12px] bg-(--row-hover) text-xs text-secondary [-webkit-tap-highlight-color:transparent] aria-[current=page]:bg-(--row-active) aria-[current=page]:text-foreground'
										>
											<item.icon
												size={22}
												stroke={1.75}
												aria-hidden='true'
												className={current ? 'text-accent' : 'text-muted'}
											/>
											<span className='max-w-full truncate px-1'>{item.label}</span>
										</Link>
									</li>
								)
							})}
						</ul>
					</section>
				))}
			</nav>
			<Profile collapsed={false} instant={false} />
		</>
	)
}

function SidebarNav({
	baseId,
	collapsed,
	projectsOpen,
	instant,
	onNavigate,
	onProjects,
}: {
	baseId: string
	collapsed: boolean
	projectsOpen: boolean
	instant: boolean
	onNavigate: () => void
	onProjects: () => void
}) {
	const pathname = useRouterState({ select: state => state.location.pathname })
	const { projectId } = useParams({ strict: false })
	const environmentId = useEnvironmentId()
	const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects })
	const shared = { collapsed, tips: collapsed, layoutId: 'side-nav', instant }
	const listId = `${baseId}-projects-list`
	const expanded = projectsOpen && !collapsed
	const onProjectsPage = pathname.startsWith('/projects')

	const leaf = (item: NavItem) => {
		const current = isActive(item, pathname)
		return (
			<li key={item.to}>
				<NavRow
					render={<Link to={item.to} draggable={false} onClick={onNavigate} />}
					label={item.label}
					icon={item.icon}
					current={current}
					lit={current}
					{...shared}
				/>
			</li>
		)
	}

	return (
		<motion.nav
			aria-label='vexdock'
			layoutScroll
			className='flex min-h-0 flex-1 [scrollbar-width:none] flex-col overflow-x-clip overflow-y-auto overscroll-contain px-3 pt-1 pb-2 [&::-webkit-scrollbar]:hidden'
		>
			<ul role='list' className='grid grid-cols-[minmax(0,1fr)] gap-px'>
				{home.map(leaf)}
				<li>
					<NavRow
						render={<button type='button' aria-label='Projects' onClick={onProjects} />}
						label='Projects'
						icon={IconFolder}
						current={false}
						lit={onProjectsPage && !expanded}
						expanded={expanded}
						turned={projectsOpen}
						controls={listId}
						{...shared}
					/>
					<motion.ul
						id={listId}
						role='list'
						inert={!expanded}
						className='relative grid grid-cols-[minmax(0,1fr)] gap-px before:absolute before:top-1 before:bottom-2 before:left-5 before:w-px before:bg-border *:first:mt-0.5 *:last:mb-1'
						initial={false}
						animate={
							expanded
								? { height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }
								: { height: 0, opacity: 0, overflow: 'hidden' }
						}
						transition={{
							height: instant ? none : motionTokens.spring.smooth,
							opacity: instant
								? none
								: {
										duration: expanded ? motionTokens.duration.standard : 0.1,
										delay: expanded ? 0.04 : 0,
										ease: standardEase,
									},
						}}
					>
						<li>
							<NavRow
								render={<Link to='/projects' draggable={false} onClick={onNavigate} />}
								label='All projects'
								count={projects.data?.length}
								nested
								current={pathname === '/projects'}
								lit={expanded && pathname === '/projects'}
								{...shared}
							/>
						</li>
						{projects.data?.map(project => {
							const current = project.id === projectId
							return (
								<li key={project.id}>
									<NavRow
										render={
											<Link
												to='/projects/$projectId'
												params={{ projectId: project.id }}
												// The environment is the project's own, so a link out of this
												// project must drop the one in the URL or the manager 404s it.
												search={{ env: current ? environmentId : undefined }}
												draggable={false}
												onClick={onNavigate}
											/>
										}
										label={project.name}
										count={project.service_count}
										nested
										current={current}
										lit={expanded && current}
										{...shared}
									/>
								</li>
							)
						})}
					</motion.ul>
				</li>
			</ul>
			<NavSection id={`${baseId}-docker`} heading='Docker' collapsed={collapsed} instant={instant}>
				{docker.map(leaf)}
			</NavSection>
			<NavSection id={`${baseId}-system`} heading='System' collapsed={collapsed} instant={instant}>
				{system.map(leaf)}
			</NavSection>
			<ul role='list' className='mt-auto grid grid-cols-[minmax(0,1fr)] gap-px pt-2'>
				{leaf(settings)}
			</ul>
		</motion.nav>
	)
}

function NavSection({
	id,
	heading,
	collapsed,
	instant,
	children,
}: {
	id: string
	heading: string
	collapsed: boolean
	instant: boolean
	children: ReactNode
}) {
	return (
		<div role='group' aria-labelledby={id} className='mt-1'>
			<motion.div
				className='relative overflow-hidden'
				initial={false}
				animate={{ height: collapsed ? 17 : 32 }}
				transition={instant ? none : motionTokens.spring.smooth}
			>
				<motion.span
					id={id}
					className='absolute bottom-[7px] left-3 text-xs/none font-medium whitespace-nowrap text-muted'
					initial={false}
					animate={{ opacity: collapsed ? 0 : 1, x: collapsed ? -6 : 0 }}
					transition={labelTransition(collapsed, instant)}
				>
					{heading}
				</motion.span>
				<motion.span
					aria-hidden='true'
					className='absolute inset-x-2 top-2 h-px bg-border'
					initial={false}
					animate={{ opacity: collapsed ? 1 : 0, scaleX: collapsed ? 1 : 0.3 }}
					transition={railMarkTransition(collapsed, instant)}
				/>
			</motion.div>
			<ul role='list' className='grid grid-cols-[minmax(0,1fr)] gap-px'>
				{children}
			</ul>
		</div>
	)
}

/** One row of the rail: a Link for a destination, a button for the Projects group; `render` says which. */
function NavRow({
	render,
	label,
	icon: RowIcon,
	count,
	nested = false,
	current,
	lit,
	expanded,
	turned,
	controls,
	collapsed,
	tips,
	layoutId,
	instant,
}: {
	render: ReactElement
	label: string
	icon?: TablerIcon
	count?: number
	nested?: boolean
	current: boolean
	lit: boolean
	expanded?: boolean
	turned?: boolean
	controls?: string
	collapsed: boolean
	tips: boolean
	layoutId: string
	instant: boolean
}) {
	const textTransition = labelTransition(collapsed, instant)
	return (
		<BaseTooltip.Root disabled={!tips}>
			<BaseTooltip.Trigger
				render={render}
				className={cn(
					'group/item relative isolate flex h-8 w-full items-center gap-2.5 rounded-[8px] pr-2.5 pl-3 text-left text-[13px] whitespace-nowrap transition-colors duration-110 ease-standard [-webkit-tap-highlight-color:transparent] active:bg-(--row-active) in-data-dragging:active:bg-transparent motion-reduce:transition-none pointer-coarse:h-10',
					lit ? 'text-foreground' : 'text-secondary hover:bg-(--row-hover) hover:text-foreground',
					nested && 'ml-7 h-[30px] w-[calc(100%-28px)] pl-2.5',
				)}
				aria-current={current ? 'page' : undefined}
				aria-expanded={expanded}
				aria-controls={controls}
			>
				{lit ? <ActivePill layoutId={layoutId} className='rounded-[8px] bg-(--row-active)' /> : null}
				{RowIcon ? (
					<RowIcon
						size={16}
						stroke={1.75}
						aria-hidden='true'
						className={cn(
							'flex-none transition-colors duration-110 ease-standard motion-reduce:transition-none',
							lit ? 'text-accent' : 'text-muted group-hover/item:text-secondary',
						)}
					/>
				) : null}
				<motion.span
					className='block min-w-0 flex-auto overflow-hidden text-ellipsis'
					initial={false}
					animate={{ opacity: collapsed ? 0 : 1, x: collapsed ? -6 : 0 }}
					transition={textTransition}
				>
					{label}
				</motion.span>
				{count === undefined ? null : (
					<motion.span
						className='flex-none text-xs/none text-muted tabular-nums'
						initial={false}
						animate={{ opacity: collapsed ? 0 : 1 }}
						transition={textTransition}
					>
						{count}
					</motion.span>
				)}
				{turned === undefined ? null : (
					<motion.span
						aria-hidden='true'
						className='grid flex-none place-items-center text-muted'
						initial={false}
						animate={{ opacity: collapsed ? 0 : 1, rotate: turned ? 90 : 0 }}
						transition={{ opacity: textTransition, rotate: instant ? none : motionTokens.spring.snappy }}
					>
						<IconChevronRight size={14} stroke={1.75} />
					</motion.span>
				)}
			</BaseTooltip.Trigger>
			<BaseTooltip.Portal>
				<BaseTooltip.Positioner className='z-60' side='right' sideOffset={14} collisionPadding={8}>
					<BaseTooltip.Popup className='flex items-center gap-2 rounded-control bg-foreground px-3 py-[7px] font-sans text-[13px]/[1.3] font-medium whitespace-nowrap text-background shadow-raised transition-[opacity,translate] duration-110 ease-enter data-ending-style:opacity-0 data-ending-style:duration-85 data-starting-style:opacity-0 motion-safe:data-ending-style:-translate-x-0.5 motion-safe:data-starting-style:-translate-x-1 motion-safe:data-instant:data-starting-style:translate-x-0 motion-reduce:transition-opacity motion-reduce:duration-85 motion-reduce:ease-linear'>
						{label}
					</BaseTooltip.Popup>
				</BaseTooltip.Positioner>
			</BaseTooltip.Portal>
		</BaseTooltip.Root>
	)
}

/** The mark and the running version; an update in flight or waiting tints the version and the row opens About. */
function Brand({ collapsed, instant, className }: { collapsed: boolean; instant: boolean; className?: string }) {
	const version = useQuery({ queryKey: ['version'], queryFn: api.version, refetchInterval: 60_000 })
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

	let versionText = version.data?.current ?? 'dev'
	let versionClass: string | undefined
	if (updating) {
		versionText = restarting ? 'restarting…' : `updating → ${updateState.data?.target}`
		versionClass = 'text-warning'
	} else if (version.data?.update_available) {
		versionText = `${version.data.current} → ${version.data.latest}`
		versionClass = 'text-success'
	}

	return (
		<Link
			to='/system/settings/about'
			draggable={false}
			aria-label={`vexdock ${versionText}`}
			className={cn('flex h-13 min-w-0 flex-none items-center gap-3 pr-3 pl-[18px] whitespace-nowrap', className)}
		>
			<span
				aria-hidden='true'
				className='grid size-7 flex-none place-items-center rounded-[9px] bg-foreground text-background shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--background)_12%,transparent)] dark:shadow-none'
			>
				<Logo className='size-[55%]' />
			</span>
			<IdentityText
				title='vexdock'
				detail={versionText}
				detailClassName={versionClass}
				collapsed={collapsed}
				instant={instant}
			/>
		</Link>
	)
}

function Profile({ collapsed, instant }: { collapsed: boolean; instant: boolean }) {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const session = useSession()
	const logout = useMutation({
		mutationFn: () => signOut(),
		onSuccess: async () => {
			queryClient.clear()
			await navigate({ to: '/login', replace: true })
		},
	})
	const email = session.data?.user.email ?? ''
	const name = session.data?.user.name || 'Account'

	return (
		<div className='flex h-13 min-w-0 flex-none items-center border-t border-border-subtle px-2'>
			<DropdownMenu
				side='top'
				align='start'
				menuClassName='w-56'
				trigger={
					<button
						type='button'
						aria-label={name}
						className='flex h-10 w-full min-w-0 items-center gap-3 rounded-[8px] pr-2 pl-2.5 text-left whitespace-nowrap transition-colors duration-110 ease-standard hover:bg-(--row-hover) motion-reduce:transition-none'
					>
						<Avatar name={name} size='sm' aria-hidden />
						<IdentityText title={name} detail={email} collapsed={collapsed} instant={instant} />
					</button>
				}
				items={[
					{
						label: 'About',
						icon: <IconInfoCircle size={16} stroke={1.75} />,
						href: '/system/settings/about',
					},
					{
						label: 'Log out',
						icon: <IconLogout size={16} stroke={1.75} />,
						separatorBefore: true,
						onSelect: () => logout.mutate(),
					},
				]}
			/>
		</div>
	)
}

function IdentityText({
	title,
	detail,
	detailClassName,
	collapsed,
	instant,
}: {
	title: string
	detail: string
	detailClassName?: string
	collapsed: boolean
	instant: boolean
}) {
	return (
		<motion.span
			className='grid min-w-0 gap-0.5 leading-[1.25]'
			initial={false}
			animate={{ opacity: collapsed ? 0 : 1, x: collapsed ? -6 : 0 }}
			transition={labelTransition(collapsed, instant)}
		>
			<strong className='overflow-hidden text-[13px] font-medium text-ellipsis text-foreground'>{title}</strong>
			<span className={cn('overflow-hidden text-xs/[1.25] text-ellipsis text-muted', detailClassName)}>
				{detail}
			</span>
		</motion.span>
	)
}

function PaneIcon({ collapsed, instant }: { collapsed: boolean; instant: boolean }) {
	return (
		<svg
			width='20'
			height='20'
			viewBox='0 0 20 20'
			fill='none'
			stroke='currentColor'
			strokeWidth='1.6'
			strokeLinecap='round'
			aria-hidden='true'
		>
			<rect x='2.75' y='3.75' width='14.5' height='12.5' rx='3.5' />
			<motion.path
				d='M8.25 4.25v11.5'
				initial={false}
				animate={{ x: collapsed ? -2.5 : 0 }}
				transition={instant ? none : motionTokens.spring.smooth}
			/>
		</svg>
	)
}
