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
	IconRefresh,
	IconSearch,
	IconSettings,
	IconStack2,
	IconTrash,
	IconX,
	type Icon as TablerIcon,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { cn } from 'cn'
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform, type Transition } from 'motion/react'
import { Avatar } from '@/components/ui/avatar'
import { DropdownMenu } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { updateActive } from '../lib/api'
import { signOut, useSession } from '../lib/auth-client'
import { useEnvironmentId } from '../lib/environment'
import { useFocusRescue } from '../lib/focus-rescue'
import { motionTokens } from '../lib/motion'
import { projectsQuery, updateStateQuery, versionQuery } from '../lib/queries'
import { useSystemEvents } from '../lib/sse'
import { CommandMenu } from './command-menu'
import { DeploymentInbox } from './deployment-inbox'
import { Logo } from './logo'
import { ActivePill, IconButton, Keys, mod, PageChrome, Tabs, useServedPath } from './primitives'

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
const isProjectsPath = (pathname: string) => pathname === '/projects' || pathname.startsWith('/projects/')

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
		? { duration: motionTokens.duration.fast, ease: standardEase }
		: { duration: motionTokens.duration.standard, delay: 0.07, ease: enterEase }
}

// The section divider arrives once the rail has narrowed.
function railMarkTransition(collapsed: boolean, instant: boolean): Transition {
	if (instant) return none
	return collapsed
		? { duration: motionTokens.duration.fast, delay: 0.11, ease: enterEase }
		: { duration: motionTokens.duration.instant, ease: standardEase }
}

const iconButton =
	'inline-grid size-control-md flex-none place-items-center rounded-control text-secondary transition-colors duration-110 ease-standard [-webkit-tap-highlight-color:transparent] hover:bg-surface-muted hover:text-foreground active:bg-[color-mix(in_oklab,var(--foreground)_9%,transparent)] active:text-foreground pointer-coarse:size-11'

// workspace-sidebar's toggleClass, pinned to the search row's right edge so the 64 wide rail keeps it centered.
const railToggle =
	'absolute top-1/2 right-1 -mt-4 grid size-8 place-items-center rounded-[8px] text-secondary [-webkit-tap-highlight-color:transparent] hover:bg-(--row-hover) hover:text-foreground active:bg-(--row-active) active:text-foreground pointer-coarse:-right-0.5 pointer-coarse:-mt-5.5 pointer-coarse:size-11'

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
	const railReturn = useRef<HTMLElement | null>(null)
	const sidebarId = `${baseId}-sidebar`
	const floating = tablet && !collapsed

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
			// A modal owns the keyboard; of the dialogs only the More sheet answers `[`, by closing.
			const dialog = target instanceof Element ? target.closest('[role=dialog],[role=alertdialog]') : null
			if (dialog && dialog !== sheetRef.current) return
			if (!shell) return
			event.preventDefault()
			if (shell.clientWidth < 480) {
				if (moreOpen) sheetActions.current?.close()
				else setMoreOpen(true)
				return
			}
			// Opening the floating rail (480 to 640 px) makes the page inert, so the focus it leaves is kept for the close.
			if (collapsed && shell.clientWidth < 640 && target instanceof HTMLElement) railReturn.current = target
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

	useEffect(() => {
		const rail = document.querySelector(`#${sidebarId}`)
		if (floating) {
			if (railReturn.current && rail && !rail.contains(document.activeElement)) railFocusTarget(rail)?.focus()
			return
		}
		const back = railReturn.current
		railReturn.current = null
		if (back?.isConnected) back.focus({ preventScroll: true })
	}, [floating, sidebarId])

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
		// The page the focus came from is gone; the focus rescue finds a place on the new one.
		railReturn.current = null
		window.clearTimeout(closeTimer.current)
		closeTimer.current = window.setTimeout(
			() => (fromSheet ? sheetActions.current?.close() : setCollapsed(true)),
			instant ? 0 : 125,
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
				className='@container/shell relative isolate flex h-dvh min-h-0 min-w-0 overflow-hidden bg-background text-foreground [--rail:color-mix(in_oklab,var(--surface-muted)_55%,var(--surface))] [--row-active:color-mix(in_oklab,var(--foreground)_7%,transparent)] [--row-hover:color-mix(in_oklab,var(--foreground)_4.5%,transparent)] dark:[--rail:color-mix(in_oklab,var(--background)_60%,var(--surface))] dark:[--row-active:color-mix(in_oklab,var(--foreground)_8%,transparent)] dark:[--row-hover:color-mix(in_oklab,var(--foreground)_5%,transparent)]'
				onKeyDown={event => {
					if (event.key !== 'Escape' || !floating || event.defaultPrevented) return
					event.preventDefault()
					collapseRail()
				}}
			>
				<a
					href='#content'
					className='sr-only z-50 rounded-control border bg-surface px-3 py-2 text-sm font-medium focus:not-sr-only focus:absolute focus:top-2 focus:left-2'
				>
					Skip to content
				</a>
				<motion.div
					className='relative z-3 h-full flex-none @max-[480px]/shell:hidden'
					initial={false}
					animate={{ width: tablet || collapsed ? 64 : 240 }}
					transition={panelSpring}
				>
					<motion.div
						id={sidebarId}
						className='absolute inset-y-0 left-0 flex min-w-0 flex-col overflow-hidden bg-(--rail) transition-shadow duration-170 ease-standard after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border data-floating:shadow-floating'
						initial={false}
						animate={{ width: collapsed ? 64 : 240 }}
						transition={panelSpring}
						data-collapsed={collapsed || undefined}
						data-floating={floating || undefined}
					>
						<Brand
							collapsed={collapsed}
							instant={instant}
							eventsLost={eventsLost}
							onNavigate={() => navigated(false)}
							overlay={floating}
						/>
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
							floating={floating}
							onNavigate={() => navigated(false)}
							onProjects={toggleProjects}
						/>
						<Profile collapsed={collapsed} instant={instant} onNavigate={() => navigated(false)} />
					</motion.div>
				</motion.div>
				{/* Mounted for good so data-open drops the moment the rail closes: the page comes forward as the scrim
				    fades (styles.css, the Recede recipe). */}
				<div
					data-scrim
					data-open={floating || undefined}
					aria-hidden='true'
					onClick={collapseRail}
					className={cn(
						scrim,
						'pointer-events-none z-2 opacity-0 transition-opacity duration-125 ease-exit data-open:pointer-events-auto data-open:opacity-100 data-open:duration-170 data-open:ease-standard',
					)}
				/>
				{/* The floating rail is modal over the page: Tab stays in the rail until it closes. */}
				<div inert={floating} className='relative isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
					<header className='flex min-h-13 flex-none items-center gap-3 px-6 pt-6 @max-[480px]/shell:gap-1 @max-[480px]/shell:px-4 @max-[480px]/shell:pt-[max(0.75rem,env(safe-area-inset-top,0px))]'>
						{/* The page's breadcrumb, title and actions land here, so a page owns what it
						    is called without owning a bar of its own. The 4px padding keeps the actions'
						    focus outlines (2px at 2px offset) inside the clip. */}
						<div
							ref={setHeader}
							className='-m-1 flex min-w-0 flex-1 items-center gap-3 overflow-hidden p-1'
						/>
						<DeploymentInbox />
					</header>
					<SectionStrip />
					<PageChrome value={header}>{children}</PageChrome>
					<TabBar
						moreOpen={moreOpen}
						moreButtonRef={moreButtonRef}
						eventsLost={eventsLost}
						onSearch={() => setSearchOpen(true)}
						onMore={() => setMoreOpen(true)}
					/>
				</div>
				{/* Outside the inert page: "Sidebar expanded" lands in the same render that makes it inert. */}
				<p role='status' aria-live='polite' className='sr-only'>
					{announcement}
				</p>
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
						// The one focus return, held or instant close alike: the More tab takes it a frame later, once the shell is no longer inert.
						const focusWasInSheet =
							document.activeElement === document.body || document.activeElement?.closest('[role=dialog]')
						if (!focusWasInSheet) return
						requestAnimationFrame(() => {
							const more = moreButtonRef.current
							const rail = document.querySelector(`#${sidebarId}`)
							// A phone turned past 480 px closes the sheet and hides the tab bar; the rail took its place.
							const target = more?.offsetParent ? more : rail && railFocusTarget(rail)
							target?.focus({ preventScroll: true })
						})
					}}
				>
					<AnimatePresence onExitComplete={() => sheetActions.current?.unmount()}>
						{moreOpen && shell && (
							<Dialog.Portal keepMounted container={shell}>
								<Dialog.Backdrop
									// The page recedes under the sheet (styles.css, the Recede recipe).
									data-scrim
									render={
										<motion.div className={cn(scrim, 'z-20')} style={{ opacity: sheetShown }} />
									}
								/>
								<Dialog.Popup
									ref={sheetRef}
									initialFocus={() =>
										sheetRef.current?.querySelector<HTMLElement>('[aria-current]') ?? true
									}
									finalFocus={false}
									render={
										<motion.div
											className='absolute inset-x-0 bottom-0 z-21 flex max-h-[calc(100%-40px)] touch-none flex-col overscroll-contain rounded-t-[16px] border-t border-border bg-(--rail) pr-[env(safe-area-inset-right,0)] pb-[env(safe-area-inset-bottom,0)] pl-[env(safe-area-inset-left,0)] shadow-floating'
											style={{ y: sheetY }}
											initial={{ y: '100%' }}
											animate={{ y: 0 }}
											// A spring, so a flung sheet keeps its speed; the shorter one, since exits beat entrances.
											exit={{
												y: '100%',
												transition: instant ? none : motionTokens.spring.snappy,
											}}
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
										<Brand
											collapsed={false}
											instant={instant}
											eventsLost={eventsLost}
											className='flex-1'
											onNavigate={() => {
												if (!sheetDragging.current) navigated(true)
											}}
											overlay
										/>
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
		<div className='relative mx-3 mb-2 flex h-10 flex-none items-center pointer-coarse:h-11'>
			<motion.button
				type='button'
				inert={collapsed}
				aria-haspopup='dialog'
				aria-keyshortcuts='Meta+K Control+K'
				className={cn(
					'flex h-8 w-full min-w-0 items-center gap-2 rounded-[8px] border border-border bg-surface pr-1.5 pl-2.5 text-left text-[13px] whitespace-nowrap text-muted transition-colors duration-110 ease-standard [-webkit-tap-highlight-color:transparent] hover:border-border-strong hover:text-secondary active:bg-surface-pressed pointer-coarse:h-11',
					children && 'mr-10 pointer-coarse:mr-12',
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
	'press flex h-full min-w-0 flex-col items-center justify-center gap-1 text-xs/none font-medium text-muted [-webkit-tap-highlight-color:transparent] [--focus-outline-offset:-2px] active:text-foreground data-lit:text-foreground'

/** The rail below 480: three destinations, the command menu and the More sheet, under the thumb. */
function TabBar({
	moreOpen,
	moreButtonRef,
	eventsLost,
	onSearch,
	onMore,
}: {
	moreOpen: boolean
	moreButtonRef: RefObject<HTMLButtonElement | null>
	/** The sheet's Brand row says "reconnecting…"; the More tab carries a dot so a closed sheet does not hide it. */
	eventsLost: boolean
	onSearch: () => void
	onMore: () => void
}) {
	const pathname = useServedPath()
	let lit: 'home' | 'projects' | 'docker' | 'more' | undefined
	if (pathname === '/') lit = 'home'
	else if (isProjectsPath(pathname)) lit = 'projects'
	else if (docker.some(item => isActive(item, pathname))) lit = 'docker'
	// A URL no route serves lights no tab.
	else if (moreGroups.some(group => group.items.some(item => isActive(item, pathname)))) lit = 'more'

	return (
		<nav
			aria-label='Tabs'
			className='hidden h-(--tab-bar) flex-none grid-cols-5 border-t border-border bg-(--rail) pb-[env(safe-area-inset-bottom,0px)] @max-[480px]/shell:grid'
		>
			<Link
				to='/'
				activeOptions={exactOnly}
				draggable={false}
				className={tabItem}
				data-lit={lit === 'home' || undefined}
				aria-current={tabCurrent(lit === 'home', true)}
			>
				<TabFace icon={IconHome} label='Dashboard' lit={lit === 'home'} />
			</Link>
			<Link
				to='/projects'
				activeOptions={exactOnly}
				draggable={false}
				className={tabItem}
				data-lit={lit === 'projects' || undefined}
				aria-current={tabCurrent(lit === 'projects', pathname === '/projects')}
			>
				<TabFace icon={IconFolder} label='Projects' lit={lit === 'projects'} />
			</Link>
			<Link
				to='/docker/containers'
				search={{ q: undefined }}
				activeOptions={exactOnly}
				draggable={false}
				className={tabItem}
				data-lit={lit === 'docker' || undefined}
				aria-current={tabCurrent(lit === 'docker', pathname === '/docker/containers')}
			>
				<TabFace icon={IconBrandDocker} label='Docker' lit={lit === 'docker'} />
			</Link>
			<button
				type='button'
				className={tabItem}
				aria-haspopup='dialog'
				aria-keyshortcuts='Meta+K Control+K'
				onClick={onSearch}
			>
				<TabFace icon={IconSearch} label='Search' lit={false} />
			</button>
			<button
				ref={moreButtonRef}
				type='button'
				className={tabItem}
				data-lit={lit === 'more' || undefined}
				aria-current={tabCurrent(lit === 'more', false)}
				aria-haspopup='dialog'
				aria-expanded={moreOpen}
				aria-keyshortcuts='['
				aria-label={eventsLost ? 'More, live updates lost' : undefined}
				onClick={onMore}
			>
				<TabFace icon={IconDots} label='More' lit={lit === 'more'} warning={eventsLost} />
			</button>
		</nav>
	)
}

// TanStack's Link writes `aria-current="page"` over the caller's own on any prefix match; exact leaves it to the shell.
const exactOnly = { exact: true, includeSearch: false }

/** The rail's row for the page the reader is on, or its collapse toggle; rows in a folded list are inert. */
function railFocusTarget(rail: Element) {
	const rows = [...rail.querySelectorAll<HTMLElement>('[aria-current]')]
	return rows.find(row => !row.closest('[inert]')) ?? rail.querySelector<HTMLElement>('[aria-keyshortcuts="["]')
}

/** A lit tab is the page when its own URL is open, and the current section when a page below it is. */
function tabCurrent(lit: boolean, exact: boolean) {
	if (!lit) return
	return exact ? 'page' : 'true'
}
function TabFace({
	icon: TabIcon,
	label,
	lit,
	warning,
}: {
	icon: TablerIcon
	label: string
	lit: boolean
	warning?: boolean
}) {
	return (
		<>
			<span className='relative isolate grid h-7 w-14 place-items-center rounded-full'>
				{lit ? <ActivePill layoutId='tab-bar' className='bg-(--row-active)' /> : null}
				<TabIcon size={22} stroke={1.75} aria-hidden='true' className={lit ? 'text-accent' : undefined} />
				{warning ? (
					<span className='absolute top-0 right-3 size-2.5 rounded-full bg-current text-warning ring-2 ring-(--rail)' />
				) : null}
			</span>
			<span className='max-w-full truncate px-1'>{label}</span>
		</>
	)
}

/** Below 480 the rail's Docker and System groups become a tab strip on the pages they hold. */
function SectionStrip() {
	const pathname = useServedPath()
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
	const pathname = useServedPath()
	return (
		<>
			<nav aria-label='More' className='grid gap-3 px-3 pb-3'>
				{moreGroups.map(group => (
					<section key={group.heading} aria-labelledby={`more-${group.heading}`}>
						<h2 id={`more-${group.heading}`} className='px-1 pb-1.5 text-xs/none font-medium text-muted'>
							{group.heading}
						</h2>
						<ul role='list' className='grid grid-cols-4 gap-1.5'>
							{group.items.map(item => {
								const lit = isActive(item, pathname)
								return (
									<li key={item.to}>
										<Link
											to={item.to}
											activeOptions={exactOnly}
											draggable={false}
											// The sheet's exit is the motion; a page swap would freeze it in the snapshot.
											viewTransition={false}
											onClick={onNavigate}
											data-lit={lit || undefined}
											aria-current={tabCurrent(lit, pathname === item.to)}
											className='flex h-18 press flex-col items-center justify-center gap-1.5 rounded-[12px] bg-(--row-hover) text-xs text-secondary [-webkit-tap-highlight-color:transparent] data-lit:bg-(--row-active) data-lit:text-foreground'
										>
											<item.icon
												size={22}
												stroke={1.75}
												aria-hidden='true'
												className={lit ? 'text-accent' : 'text-muted'}
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
			<Profile collapsed={false} instant={false} onNavigate={onNavigate} />
		</>
	)
}

function SidebarNav({
	baseId,
	collapsed,
	projectsOpen,
	instant,
	floating,
	onNavigate,
	onProjects,
}: {
	baseId: string
	collapsed: boolean
	projectsOpen: boolean
	instant: boolean
	/** The rail is a drawer over the page, whose exit a page swap would freeze. */
	floating: boolean
	onNavigate: () => void
	onProjects: () => void
}) {
	const pathname = useServedPath()
	const { projectId } = useParams({ strict: false })
	const environmentId = useEnvironmentId()
	const projects = useQuery(projectsQuery)
	const shared = { collapsed, layoutId: 'side-nav', instant }
	const listId = `${baseId}-projects-list`
	const expanded = projectsOpen && !collapsed
	const onProjectsPage = isProjectsPath(pathname)
	const viewTransition = floating ? false : undefined

	const leaf = (item: NavItem) => {
		const lit = isActive(item, pathname)
		return (
			<li key={item.to}>
				<NavRow
					render={
						<Link
							to={item.to}
							activeOptions={exactOnly}
							draggable={false}
							viewTransition={viewTransition}
							onClick={onNavigate}
						/>
					}
					label={item.label}
					icon={item.icon}
					current={pathname === item.to}
					lit={lit}
					{...shared}
				/>
			</li>
		)
	}

	return (
		<motion.nav
			aria-label='Main'
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
										duration: expanded
											? motionTokens.duration.standard
											: motionTokens.duration.fast,
										delay: expanded ? 0.04 : 0,
										ease: standardEase,
									},
						}}
					>
						<li>
							<NavRow
								render={
									<Link
										to='/projects'
										activeOptions={exactOnly}
										draggable={false}
										viewTransition={viewTransition}
										onClick={onNavigate}
									/>
								}
								label='All projects'
								count={projects.data?.length}
								nested
								current={pathname === '/projects'}
								lit={expanded && pathname === '/projects'}
								{...shared}
							/>
						</li>
						{projects.data?.map(project => {
							const onProject = pathname !== '' && project.id === projectId
							return (
								<li key={project.id}>
									<NavRow
										render={
											<Link
												to='/projects/$projectId'
												params={{ projectId: project.id }}
												activeOptions={exactOnly}
												// The environment is the project's own, so a link out of this
												// project must drop the one in the URL or the manager 404s it.
												search={{ env: onProject ? environmentId : undefined }}
												draggable={false}
												viewTransition={viewTransition}
												onClick={onNavigate}
											/>
										}
										label={project.name}
										count={project.service_count}
										nested
										current={pathname === `/projects/${project.id}`}
										lit={expanded && onProject}
										{...shared}
									/>
								</li>
							)
						})}
						{projects.isPending ? (
							<li className='ml-7 flex h-[30px] items-center pl-2.5'>
								<Skeleton label='Loading projects' lines={1} className='w-24' />
							</li>
						) : null}
						{projects.isError ? (
							<li className='ml-7 flex min-h-[30px] items-center justify-between gap-1 pl-2.5 text-xs text-danger'>
								<span className='truncate'>Could not load projects</span>
								<IconButton
									icon={IconRefresh}
									label='Load projects again'
									loading={projects.isFetching}
									onClick={() => projects.refetch()}
								/>
							</li>
						) : null}
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
	layoutId: string
	instant: boolean
}) {
	const textTransition = labelTransition(collapsed, instant)
	return (
		// Only a collapsed rail hides the labels, so only it needs them as tooltips.
		<BaseTooltip.Root disabled={!collapsed}>
			<BaseTooltip.Trigger
				render={render}
				className={cn(
					'group/item relative isolate flex h-8 w-full items-center gap-2.5 rounded-[8px] pr-2.5 pl-3 text-left text-[13px] whitespace-nowrap transition-colors duration-110 ease-standard [-webkit-tap-highlight-color:transparent] active:bg-(--row-active) in-data-dragging:active:bg-transparent pointer-coarse:h-11',
					lit ? 'text-foreground' : 'text-secondary hover:bg-(--row-hover) hover:text-foreground',
					nested && 'ml-7 h-[30px] w-[calc(100%-28px)] pl-2.5',
				)}
				// A lit row that is not the page (Projects, with its list folded) still says where the reader is.
				aria-current={tabCurrent(current || lit, current)}
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
							'flex-none transition-colors duration-110 ease-standard',
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
			<RailTip label={label} />
		</BaseTooltip.Root>
	)
}

/** The collapsed rail hides a row's text, so the row's own `BaseTooltip.Root` shows it beside the rail instead. */
function RailTip({ label }: { label: string }) {
	return (
		<BaseTooltip.Portal>
			<BaseTooltip.Positioner className='z-60' side='right' sideOffset={14} collisionPadding={8}>
				<BaseTooltip.Popup className='flex items-center gap-2 rounded-control bg-foreground px-3 py-[7px] font-sans text-[13px]/[1.3] font-medium whitespace-nowrap text-background shadow-raised transition-[opacity,translate] duration-110 ease-enter data-ending-style:opacity-0 data-ending-style:duration-85 data-starting-style:opacity-0 motion-safe:data-ending-style:-translate-x-0.5 motion-safe:data-starting-style:-translate-x-1 motion-safe:data-instant:data-starting-style:translate-x-0 motion-reduce:transition-opacity motion-reduce:duration-85 motion-reduce:ease-linear'>
					{label}
				</BaseTooltip.Popup>
			</BaseTooltip.Positioner>
		</BaseTooltip.Portal>
	)
}

/** The mark and the running version; an update in flight or waiting, or a lost event stream, tints the version and
 * the row opens About. */
function Brand({
	collapsed,
	instant,
	eventsLost,
	className,
	onNavigate,
	overlay,
}: {
	collapsed: boolean
	instant: boolean
	/** The panel stops refreshing on its own until `/api/system/events` opens again. */
	eventsLost: boolean
	className?: string
	/** Closes the sheet or floating rail the row sits in. */
	onNavigate: () => void
	/** The row sits in the More sheet or the floating rail, whose exit a page swap would freeze in its snapshot. */
	overlay: boolean
}) {
	const version = useQuery({ ...versionQuery, refetchInterval: 60_000 })
	// The update state is a tiny file read; polling it keeps the bar honest
	// about an update started on another page (or by another session).
	const updateState = useQuery({ ...updateStateQuery, refetchInterval: 10_000 })
	// A failing fetch while the last known phase was active is the manager
	// being swapped, not an error.
	const updating = updateActive(updateState.data?.phase)
	const restarting = updating && updateState.isError

	// Blank until the version answers: a made-up one would read as the running build.
	let versionText = version.data?.current ?? ''
	let brandLabel = `Vexdock ${versionText}`.trim()
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
		<div className={cn('flex h-13 min-w-0 flex-none items-center px-2', className)}>
			<BaseTooltip.Root disabled={!collapsed}>
				<BaseTooltip.Trigger
					render={
						<Link
							to='/system/settings/about'
							draggable={false}
							viewTransition={overlay ? false : undefined}
							onClick={onNavigate}
						/>
					}
					aria-label={brandLabel}
					className='flex h-10 w-full min-w-0 items-center gap-3 rounded-[8px] pr-2 pl-2.5 whitespace-nowrap transition-colors duration-110 ease-standard [-webkit-tap-highlight-color:transparent] hover:bg-(--row-hover) active:bg-(--row-active) pointer-coarse:h-11'
				>
					<span
						aria-hidden='true'
						className='relative grid size-7 flex-none place-items-center rounded-[9px] bg-foreground text-background shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--background)_12%,transparent)] dark:shadow-none'
					>
						<Logo className='size-[55%]' />
						{/* The collapsed rail hides the tinted version line; the dot keeps its tone in view, the tooltip says it. */}
						{collapsed && versionClass ? (
							<span
								className={cn(
									'absolute -top-1 -right-1 size-2.5 rounded-full bg-current ring-2 ring-(--rail)',
									versionClass,
								)}
							/>
						) : null}
					</span>
					<IdentityText
						title='vexdock'
						detail={versionText}
						detailClassName={versionClass}
						collapsed={collapsed}
						instant={instant}
					/>
				</BaseTooltip.Trigger>
				<RailTip label={brandLabel} />
			</BaseTooltip.Root>
		</div>
	)
}

function Profile({ collapsed, instant, onNavigate }: { collapsed: boolean; instant: boolean; onNavigate: () => void }) {
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
	const email = session.data?.user.email ?? ''
	const name = session.data?.user.name || 'Account'
	const label = logout.isError ? `${name}, log out failed` : name

	return (
		<div className='flex h-13 min-w-0 flex-none items-center border-t border-border-subtle px-2'>
			<BaseTooltip.Root disabled={!collapsed}>
				<DropdownMenu
					side='top'
					align='start'
					menuClassName='w-56'
					trigger={
						<BaseTooltip.Trigger
							aria-label={label}
							className='flex h-10 w-full min-w-0 items-center gap-3 rounded-[8px] pr-2 pl-2.5 text-left whitespace-nowrap transition-colors duration-110 ease-standard [-webkit-tap-highlight-color:transparent] hover:bg-(--row-hover) active:bg-(--row-active) data-popup-open:bg-(--row-hover) pointer-coarse:h-11'
						>
							<Avatar name={name} size='sm' aria-hidden />
							<IdentityText
								title={name}
								detail={logout.isError ? 'Log out failed, try again' : email}
								detailClassName={logout.isError ? 'text-danger' : undefined}
								collapsed={collapsed}
								instant={instant}
							/>
						</BaseTooltip.Trigger>
					}
					items={[
						{
							label: 'About',
							icon: <IconInfoCircle size={16} stroke={1.75} />,
							href: '/system/settings/about',
							onSelect: onNavigate,
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
				<RailTip label={label} />
			</BaseTooltip.Root>
			{/* Mounted empty: the menu has closed by the time the request fails, so nothing else would say it. */}
			<p role='alert' className='sr-only'>
				{logout.isError ? 'Log out failed, try again' : ''}
			</p>
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
