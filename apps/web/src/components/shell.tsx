import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import {
	IconActivity,
	IconAffiliate,
	IconArchive,
	IconBox,
	IconCertificate,
	IconChevronRight,
	IconClock,
	IconDatabase,
	IconFolder,
	IconHome,
	IconInfoCircle,
	IconLogout,
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
import { ActivePill, PageChrome } from './primitives'

type NavItem = { to: string; label: string; icon: TablerIcon; exact?: boolean }

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
]

const settings: NavItem = { to: '/system/settings', label: 'Settings', icon: IconSettings }

const isActive = (item: NavItem, pathname: string) => (item.exact ? pathname === item.to : pathname.startsWith(item.to))

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
	'inline-grid size-8 flex-none place-items-center rounded-[8px] text-secondary transition-colors duration-110 ease-standard [-webkit-tap-highlight-color:transparent] hover:bg-surface-muted hover:text-foreground active:bg-[color-mix(in_oklab,var(--foreground)_9%,transparent)] active:text-foreground pointer-coarse:size-10 motion-reduce:transition-none'

const scrim =
	'absolute inset-0 bg-[color-mix(in_oklab,var(--foreground)_30%,transparent)] [-webkit-tap-highlight-color:transparent] dark:bg-background/50'

/** Arc's sidebar-rail on the real routes: 240 wide, a 64 wide rail on `[` or below 760, floating below 640, a sheet below 480. */
export function Shell({ children }: { children: ReactNode }) {
	const baseId = useId()
	const reduce = useReducedMotion() ?? false
	const [booting, setBooting] = useState(true)
	const instant = reduce || booting
	const [collapsed, setCollapsed] = useState(false)
	const [tablet, setTablet] = useState(false)
	const [projectsOpen, setProjectsOpen] = useState(true)
	const [sheetOpen, setSheetOpen] = useState(false)
	const [shell, setShell] = useState<HTMLElement | null>(null)
	const [announcement, setAnnouncement] = useState('')
	// Set from the ref during commit, so the page's breadcrumb lands in the bar
	// before the first paint rather than a frame later.
	const [header, setHeader] = useState<HTMLElement | null>(null)
	const sheetRef = useRef<HTMLDivElement>(null)
	const sheetActions = useRef<Dialog.Root.Actions>(null)
	const menuButtonRef = useRef<HTMLButtonElement>(null)
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
				if (sheetOpen) sheetActions.current?.close()
				else setSheetOpen(true)
				return
			}
			setCollapsed(!collapsed)
			setAnnouncement(collapsed ? 'Sidebar expanded' : 'Sidebar collapsed')
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [shell, collapsed, sheetOpen])

	useLayoutEffect(() => {
		if (!shell) return
		const shellElement = shell
		function fit() {
			const width = shellElement.clientWidth
			if (width >= 480) setSheetOpen(false)
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

	function toggleProjects(fromSheet: boolean) {
		if (collapsed && !fromSheet) {
			setCollapsed(false)
			setProjectsOpen(true)
			setAnnouncement('Sidebar expanded')
			return
		}
		setProjectsOpen(!projectsOpen)
	}

	const sheetX = useMotionValue<string | number>('-100%')
	const sheetShown = useTransform(sheetX, x => {
		const width = sheetRef.current?.offsetWidth || 288
		const offset =
			typeof x === 'number'
				? x / width
				: x.endsWith('%')
					? Number(x.slice(0, -1)) / 100
					: Number(x.replace('px', '')) / width
		return Math.min(1, Math.max(0, 1 + (Number.isFinite(offset) ? offset : -1)))
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
						<SidebarNav
							variant='side'
							baseId={baseId}
							collapsed={collapsed}
							projectsOpen={projectsOpen}
							instant={instant}
							onNavigate={() => navigated(false)}
							onProjects={() => toggleProjects(false)}
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
				<div className='relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
					<header className='flex h-13 flex-none items-center gap-2 border-b border-border-subtle pr-4 pl-3 @max-[480px]/shell:gap-1 @max-[480px]/shell:pr-3 @max-[480px]/shell:pl-2 pointer-coarse:pl-2'>
						<Tooltip
							side='bottom'
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
								className={cn(iconButton, '@max-[480px]/shell:hidden')}
								aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
								aria-expanded={!collapsed}
								aria-controls={sidebarId}
								aria-keyshortcuts='['
								onClick={toggleRail}
							>
								<PaneIcon collapsed={collapsed} instant={instant} />
							</button>
						</Tooltip>
						<button
							ref={menuButtonRef}
							type='button'
							className={cn(iconButton, 'hidden @max-[480px]/shell:inline-grid')}
							aria-label='Open navigation'
							aria-haspopup='dialog'
							aria-expanded={sheetOpen}
							aria-keyshortcuts='['
							onClick={() => setSheetOpen(true)}
						>
							<PaneIcon collapsed={false} instant={instant} />
						</button>
						{/* The page's breadcrumb and actions land here, so a page owns what it
						    is called without owning a bar of its own. */}
						<div ref={setHeader} className='flex min-w-0 flex-1 items-center gap-3 overflow-hidden' />
						<CommandMenu
							groups={[
								{
									label: 'Go to',
									pages: [
										...home,
										{ to: '/projects', label: 'Projects', icon: IconFolder },
										settings,
									],
								},
								{ label: 'Docker', pages: docker },
								{ label: 'System', pages: system },
							]}
						/>
						<DeploymentInbox />
					</header>
					<PageChrome value={header}>{children}</PageChrome>
					<p role='status' aria-live='polite' className='sr-only'>
						{announcement}
					</p>
				</div>
				<Dialog.Root
					open={sheetOpen}
					actionsRef={sheetActions}
					onOpenChange={(open, eventDetails) => {
						// Base UI would hide the popup at once; motion's exit slide ends the closing phase instead.
						if (!open && !instant) eventDetails.preventUnmountOnClose()
						setSheetOpen(open)
					}}
					onOpenChangeComplete={open => {
						if (open) return
						// A held closing phase skips Base UI's focus return; the menu button takes it a frame later, once the shell is no longer inert.
						const focusWasInSheet =
							document.activeElement === document.body || document.activeElement?.closest('[role=dialog]')
						if (focusWasInSheet)
							requestAnimationFrame(() => menuButtonRef.current?.focus({ preventScroll: true }))
					}}
				>
					<AnimatePresence onExitComplete={() => sheetActions.current?.unmount()}>
						{sheetOpen && shell && (
							<Dialog.Portal keepMounted container={shell}>
								<Dialog.Backdrop
									render={
										<motion.div className={cn(scrim, 'z-20')} style={{ opacity: sheetShown }} />
									}
								/>
								<Dialog.Popup
									ref={sheetRef}
									initialFocus={() => {
										const current =
											sheetRef.current?.querySelector<HTMLElement>("[aria-current='page']")
										return current && !current.closest('[inert]') ? current : true
									}}
									finalFocus={() => {
										menuButtonRef.current?.focus({ preventScroll: true })
										return false
									}}
									render={
										<motion.div
											className='absolute inset-y-0 left-0 z-21 flex w-[min(288px,calc(100%-40px))] touch-pan-y flex-col overscroll-contain rounded-r-[16px] border-r border-border bg-(--rail) pt-[env(safe-area-inset-top,0)] pb-[env(safe-area-inset-bottom,0)] pl-[env(safe-area-inset-left,0)] shadow-floating'
											style={{ x: sheetX }}
											initial={{ x: '-100%' }}
											animate={{ x: 0 }}
											exit={{ x: '-100%' }}
											transition={panelSpring}
											drag={!reduce && 'x'}
											dragConstraints={{ left: 0, right: 0 }}
											dragElastic={{ left: 0.9, right: 0.04 }}
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
												if (info.offset.x < -72 || info.velocity.x < -480)
													sheetActions.current?.close()
											}}
										/>
									}
								>
									<Dialog.Title className='sr-only'>Navigation</Dialog.Title>
									<div className='flex flex-none items-center pr-3'>
										<Brand collapsed={false} instant={instant} className='flex-1' />
										<Dialog.Close
											render={
												<button
													type='button'
													className={iconButton}
													aria-label='Close navigation'
												/>
											}
										>
											<IconX size={18} stroke={1.75} aria-hidden='true' />
										</Dialog.Close>
									</div>
									<SidebarNav
										variant='sheet'
										baseId={baseId}
										collapsed={false}
										projectsOpen={projectsOpen}
										instant={instant}
										onNavigate={() => {
											if (!sheetDragging.current) navigated(true)
										}}
										onProjects={() => {
											if (!sheetDragging.current) toggleProjects(true)
										}}
									/>
									<Profile collapsed={false} instant={instant} />
								</Dialog.Popup>
							</Dialog.Portal>
						)}
					</AnimatePresence>
				</Dialog.Root>
			</div>
		</BaseTooltip.Provider>
	)
}

function SidebarNav({
	variant,
	baseId,
	collapsed,
	projectsOpen,
	instant,
	onNavigate,
	onProjects,
}: {
	variant: 'side' | 'sheet'
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
	const shared = { collapsed, tips: variant === 'side' && collapsed, layoutId: `${variant}-nav`, instant }
	const listId = `${baseId}-${variant}-projects-list`
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
			<NavSection id={`${baseId}-${variant}-docker`} heading='Docker' collapsed={collapsed} instant={instant}>
				{docker.map(leaf)}
			</NavSection>
			<NavSection id={`${baseId}-${variant}-system`} heading='System' collapsed={collapsed} instant={instant}>
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
					'group/item relative isolate flex h-8 w-full items-center gap-2.5 rounded-[8px] pr-2.5 pl-3 text-left text-[13px]/none whitespace-nowrap transition-colors duration-110 ease-standard [-webkit-tap-highlight-color:transparent] active:bg-(--row-active) in-data-dragging:active:bg-transparent motion-reduce:transition-none pointer-coarse:h-10',
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
					{ label: 'About', icon: <IconInfoCircle />, href: '/system/settings/about' },
					{
						label: 'Log out',
						icon: <IconLogout />,
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
