import {
	createContext,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type PointerEvent as ReactPointerEvent,
	type ReactElement,
	type ReactNode,
} from 'react'
import { Tooltip } from '@base-ui/react/tooltip'
import { IconCaretDownFilled, IconX } from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import {
	AnimatePresence,
	LayoutGroup,
	animate,
	motion,
	useMotionValue,
	useReducedMotion,
	useTransform,
	type TargetAndTransition,
	type Transition,
} from 'motion/react'
import { createPortal } from 'react-dom'
import { motionTokens } from '../lib/motion'

// rarv's sidebar (apps/web/src/components/ui/sidebar.tsx): a topbar over a 244 wide sidebar with a 64 wide rail on `[`,
// a drawer below 768 px. Ported without its org switcher and folders, which vexdock has no use for.

type Swipe = { id: number; x: number; y: number; time: number; axis: 'x' | 'y' | null; velocity: number }

const { duration, ease, spring } = motionTokens
const instant: Transition = { duration: 0 }
const folded: TargetAndTransition = { height: 0, opacity: 0, overflow: 'hidden' }
const unfolded: TargetAndTransition = { height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }
const fold: Transition = { ...spring.smooth, opacity: { duration: duration.fast, ease: [...ease.standard] } }
// Arc's literal timing at 0.7x: the sheet closes after a pick lands.
const SELECT_CLOSE_MS = 98
const DRAWER_QUERY = '(max-width: 767px)'

const railFade =
	'transition-[opacity,translate] delay-70 duration-170 ease-enter group-data-rail/sidebar:pointer-events-none group-data-rail/sidebar:-translate-x-1.5 group-data-rail/sidebar:opacity-0 group-data-rail/sidebar:delay-0 group-data-rail/sidebar:duration-85 group-data-rail/sidebar:ease-standard motion-reduce:translate-none'
const railFadeColor =
	'[transition:color_110ms_var(--ease-standard),opacity_170ms_var(--ease-enter)_70ms,translate_170ms_var(--ease-enter)_70ms] group-data-rail/sidebar:pointer-events-none group-data-rail/sidebar:-translate-x-1.5 group-data-rail/sidebar:opacity-0 group-data-rail/sidebar:[transition:color_110ms_var(--ease-standard),opacity_85ms_var(--ease-standard),translate_85ms_var(--ease-standard)] motion-reduce:translate-none'
const railShow =
	'opacity-0 [transition:opacity_85ms_var(--ease-standard),scale_85ms_var(--ease-standard)] group-data-rail/sidebar:scale-100 group-data-rail/sidebar:opacity-100 group-data-rail/sidebar:[transition:opacity_125ms_var(--ease-enter)_110ms,scale_225ms_var(--ease-spring)_110ms] motion-reduce:scale-100'
const rowClass =
	'group/row relative grid h-(--row) w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-1.5 rounded-control pr-[9px] pl-2 text-left group-data-rail/sidebar:pl-[13px] font-medium text-muted [-webkit-tap-highlight-color:transparent] hover:bg-(--row-hover) hover:text-foreground aria-[current=page]:text-foreground aria-[current=page]:hover:bg-transparent'
const leadClass =
	'relative z-1 grid size-3.5 place-items-center text-muted transition-colors duration-110 ease-standard group-hover/row:text-secondary group-aria-[current=page]/row:text-foreground group-hover/row:group-aria-[current=page]/row:text-foreground [&_svg]:size-3.5'
const nameClass = cn('relative z-1 min-w-0 truncate', railFadeColor)
const sidebarToggleClass =
	'grid size-7 flex-none place-items-center rounded-full text-secondary [-webkit-tap-highlight-color:transparent] hover:bg-(--row-hover) hover:text-foreground active:bg-(--row-active) active:text-foreground pointer-coarse:size-10'
const sidebarRowVars =
	'[--row-active:color-mix(in_oklab,var(--foreground)_7%,transparent)] [--row-hover:color-mix(in_oklab,var(--foreground)_4.5%,transparent)] [--row:28px] dark:[--row-active:color-mix(in_oklab,var(--foreground)_13%,transparent)] dark:[--row-hover:color-mix(in_oklab,var(--foreground)_7%,transparent)] pointer-coarse:[--row:40px]'

const SidebarState = createContext({ rail: false, reduce: false, drawer: false })

function subscribeDrawer(onChange: () => void) {
	const query = window.matchMedia(DRAWER_QUERY)
	query.addEventListener('change', onChange)
	return () => query.removeEventListener('change', onChange)
}

/** `[` toggles the rail, or the drawer below 768 px, unless the caret is in a field or a modal owns the keyboard. */
function useBracketKey(onPress: () => void) {
	const press = useRef(onPress)
	press.current = onPress
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== '[' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
			if (event.repeat) return
			const { target } = event
			if (target instanceof HTMLElement) {
				if (target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/u.test(target.tagName)) return
				const dialog = target.closest<HTMLElement>('[role=dialog],[role=alertdialog]')
				if (dialog && dialog.dataset.sidebarSheet === undefined) return
			}
			event.preventDefault()
			press.current()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])
}

type SidebarProps = {
	label: string
	collapsed: boolean
	onCollapsedChange: (collapsed: boolean) => void
	/** Topbar content after the sidebar toggle. */
	top: ReactNode
	children: ReactNode
}

/** Renders the topbar and the sidebar as two siblings: the parent grid places them. */
export function Sidebar({ label, collapsed, onCollapsedChange, top, children }: SidebarProps) {
	const reduce = useReducedMotion() ?? false
	const drawer = useSyncExternalStore(
		subscribeDrawer,
		() => window.matchMedia(DRAWER_QUERY).matches,
		() => false,
	)
	const [sheetOpen, setSheetOpen] = useState(false)
	const [sheetShown, setSheetShown] = useState(false)
	const [announcement, setAnnouncement] = useState('')
	const rail = collapsed && !drawer
	const state = useMemo(() => ({ rail, reduce, drawer }), [rail, reduce, drawer])
	if (!drawer && (sheetOpen || sheetShown)) {
		setSheetOpen(false)
		setSheetShown(false)
	}

	const navId = useId()
	const sheetRef = useRef<HTMLDivElement>(null)
	const openerRef = useRef<HTMLButtonElement>(null)
	const restoreFocus = useRef(false)
	const closeTimer = useRef(0)
	const sheetWidth = useRef(320)
	const releaseVelocity = useRef(0)
	const swipe = useRef<Swipe | null>(null)

	const sheetX = useMotionValue(-4096)
	const sheetOpacity = useMotionValue(1)
	const backdropOpacity = useTransform(
		[sheetX, sheetOpacity],
		([x = 0, opacity = 1]: number[]) => Math.min(1, Math.max(0, 1 + x / sheetWidth.current)) * opacity,
	)
	const railProgress = useMotionValue(rail ? 0 : 1)
	const width = useTransform(railProgress, progress => `calc(64px + (var(--full) - 64px) * ${progress})`)

	function openSheet() {
		window.clearTimeout(closeTimer.current)
		const sheet = sheetRef.current
		if (sheet) sheetWidth.current = sheet.offsetLeft + sheet.offsetWidth + 12
		if (!sheetShown) {
			sheetX.jump(-sheetWidth.current)
			sheetOpacity.jump(reduce ? 0 : 1)
		}
		setSheetShown(true)
		setSheetOpen(true)
	}

	function hideSheet() {
		const focused = document.activeElement
		restoreFocus.current = !focused || focused === document.body || Boolean(sheetRef.current?.contains(focused))
		setSheetOpen(false)
	}

	function closeSheet(delay = 0) {
		window.clearTimeout(closeTimer.current)
		if (delay && !reduce) closeTimer.current = window.setTimeout(hideSheet, delay)
		else hideSheet()
	}

	function changeCollapsed(next: boolean) {
		if (next === collapsed) return
		onCollapsedChange(next)
		setAnnouncement(next ? 'Sidebar collapsed' : 'Sidebar expanded')
	}

	function endSwipe(event: ReactPointerEvent<HTMLDivElement>) {
		const gesture = swipe.current
		if (!gesture || gesture.id !== event.pointerId) return
		swipe.current = null
		if (gesture.axis !== 'x') return
		const x = sheetX.get()
		if (event.type !== 'pointercancel' && (x < -sheetWidth.current / 3 || gesture.velocity < -500)) {
			releaseVelocity.current = gesture.velocity
			closeSheet()
			return
		}
		animate(sheetX, 0, reduce ? instant : { ...spring.smooth, velocity: gesture.velocity })
	}

	useBracketKey(() => {
		if (!drawer) changeCollapsed(!collapsed)
		else if (sheetOpen) closeSheet()
		else openSheet()
	})

	useEffect(() => {
		const target = rail ? 0 : 1
		if (reduce) {
			railProgress.jump(target)
			return
		}
		const controls = animate(railProgress, target, spring.smooth)
		return () => controls.stop()
	}, [rail, reduce, railProgress])

	const pageLocked = drawer && sheetOpen
	useEffect(() => {
		if (!pageLocked) return
		const root = document.documentElement
		const saved = root.style.overflow
		root.style.overflow = 'hidden'
		return () => {
			root.style.overflow = saved
		}
	}, [pageLocked])

	useEffect(() => () => window.clearTimeout(closeTimer.current), [])

	useEffect(() => {
		if (sheetOpen) {
			sheetRef.current?.focus({ preventScroll: true })
			return
		}
		if (!restoreFocus.current) return
		restoreFocus.current = false
		openerRef.current?.focus({ preventScroll: true })
	}, [sheetOpen])

	useEffect(() => {
		if (!sheetShown) return
		const settle = () => {
			if (!sheetOpen) setSheetShown(false)
		}
		if (reduce) {
			if (sheetOpen) sheetX.jump(0)
			const controls = animate(sheetOpacity, sheetOpen ? 1 : 0, {
				duration: duration.fast,
				ease: [...ease.standard],
				onComplete: () => {
					if (!sheetOpen) sheetX.jump(-sheetWidth.current)
					settle()
				},
			})
			return () => controls.stop()
		}
		sheetOpacity.jump(1)
		const velocity = releaseVelocity.current
		releaseVelocity.current = 0
		const controls = animate(sheetX, sheetOpen ? 0 : -sheetWidth.current, {
			...spring.smooth,
			velocity,
			onComplete: settle,
		})
		return () => controls.stop()
	}, [sheetOpen, sheetShown, reduce, sheetX, sheetOpacity])

	const sidebar = (
		<motion.nav
			id={navId}
			aria-label={label}
			style={drawer ? undefined : { width }}
			data-rail={rail || undefined}
			data-placement={drawer ? 'drawer' : 'inline'}
			className={cn(
				'group/sidebar relative flex h-full min-h-0 w-[min(100%,var(--full))] max-w-full flex-none flex-col overflow-hidden font-sans text-sm text-foreground [--full:244px] [--text-xs--letter-spacing:-0.14px] data-[placement=drawer]:size-full data-[placement=drawer]:rounded-[16px] data-[placement=drawer]:border data-[placement=drawer]:border-border data-[placement=drawer]:shadow-floating',
				sidebarRowVars,
				drawer && 'bg-surface-sunken',
			)}
		>
			{drawer && (
				<div className='flex items-center justify-end gap-1 px-3 pt-3'>
					<button
						type='button'
						aria-label='Close sidebar'
						className={sidebarToggleClass}
						onClick={() => closeSheet()}
					>
						<IconX size={18} aria-hidden='true' />
					</button>
				</div>
			)}
			<motion.div
				layoutScroll
				className='relative min-h-0 flex-1 [scrollbar-width:thin] overflow-x-clip overflow-y-auto overscroll-contain px-3 pt-1 pb-3'
			>
				<LayoutGroup id={navId}>
					<div className='relative grid grid-cols-[minmax(0,1fr)] content-start'>{children}</div>
				</LayoutGroup>
			</motion.div>
			<p role='status' aria-live='polite' className='sr-only'>
				{announcement}
			</p>
		</motion.nav>
	)

	const topbar = (
		<header
			inert={sheetOpen}
			className={cn(
				'flex h-13 min-w-0 items-center gap-1.5 px-3 font-sans text-sm text-foreground md:col-span-2',
				sidebarRowVars,
			)}
		>
			{drawer ? (
				<button
					ref={openerRef}
					type='button'
					aria-label='Open sidebar'
					aria-expanded={sheetOpen}
					aria-controls={navId}
					aria-keyshortcuts='['
					className={sidebarToggleClass}
					onClick={openSheet}
				>
					<RailIcon collapsed reduce={reduce} />
				</button>
			) : (
				<RailTip enabled label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} shortcut='[' side='bottom'>
					<button
						type='button'
						aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
						aria-expanded={!collapsed}
						aria-controls={navId}
						aria-keyshortcuts='['
						className={sidebarToggleClass}
						onClick={() => changeCollapsed(!collapsed)}
					>
						<RailIcon collapsed={collapsed} reduce={reduce} />
					</button>
				</RailTip>
			)}
			{top}
		</header>
	)

	if (!drawer) {
		return (
			<Tooltip.Provider delay={250} timeout={300}>
				{topbar}
				<SidebarState value={state}>{sidebar}</SidebarState>
			</Tooltip.Provider>
		)
	}

	return (
		<>
			{topbar}
			<SidebarState value={state}>
				{createPortal(
					<>
						<motion.div
							aria-hidden='true'
							data-open={sheetOpen ? '' : undefined}
							style={{ opacity: backdropOpacity }}
							className='pointer-events-none fixed inset-0 z-50 bg-background/60 [-webkit-tap-highlight-color:transparent] data-open:pointer-events-auto'
							onClick={() => closeSheet()}
						/>
						<motion.div
							ref={sheetRef}
							role='dialog'
							aria-modal='true'
							aria-label={label}
							data-sidebar-sheet
							tabIndex={-1}
							inert={!sheetOpen}
							data-shown={sheetShown ? '' : undefined}
							style={{ x: sheetX, opacity: sheetOpacity }}
							className='invisible fixed top-[max(8px,env(safe-area-inset-top))] bottom-[max(8px,env(safe-area-inset-bottom))] left-[max(8px,env(safe-area-inset-left))] z-51 flex w-[min(304px,calc(100%-56px))] touch-pan-y will-change-transform data-shown:visible'
							onClickCapture={event => {
								if (event.target instanceof Element && event.target.closest('a[href]'))
									closeSheet(SELECT_CLOSE_MS)
							}}
							onKeyDown={event => {
								const sheet = sheetRef.current
								const target = event.target instanceof Element ? event.target : null
								if (event.defaultPrevented || !sheet || !target || !sheet.contains(target)) return
								if (event.key === 'Escape') {
									event.preventDefault()
									closeSheet()
									return
								}
								if (event.key !== 'Tab') return
								const focusable = [
									...sheet.querySelectorAll<HTMLElement>(
										'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
									),
								].filter(element => !element.closest('[inert]') && element.getClientRects().length > 0)
								const first = focusable.at(0)
								const last = focusable.at(-1)
								if (!first || !last) return
								const focused = document.activeElement
								if (event.shiftKey && (focused === first || focused === sheet)) {
									event.preventDefault()
									last.focus()
								} else if (!event.shiftKey && focused === last) {
									event.preventDefault()
									first.focus()
								}
							}}
							onPointerDown={event => {
								if (event.pointerType === 'mouse' || !sheetOpen || swipe.current) return
								const target = event.target instanceof Element ? event.target : null
								if (target?.closest('input, textarea')) return
								swipe.current = {
									id: event.pointerId,
									x: event.clientX,
									y: event.clientY,
									time: event.timeStamp,
									axis: null,
									velocity: 0,
								}
							}}
							onPointerMove={event => {
								const gesture = swipe.current
								if (!gesture || gesture.id !== event.pointerId) return
								if (!gesture.axis) {
									const dx = event.clientX - gesture.x
									const dy = event.clientY - gesture.y
									if (Math.hypot(dx, dy) < 8) return
									gesture.axis = Math.abs(dx) > 1.2 * Math.abs(dy) ? 'x' : 'y'
									if (gesture.axis === 'x') {
										gesture.x = event.clientX
										event.currentTarget.setPointerCapture(event.pointerId)
									}
									return
								}
								if (gesture.axis !== 'x') return
								const offset = event.clientX - gesture.x
								// Dragging right past the resting edge only stretches 10px, like a rubber band.
								const x = offset > 0 ? 10 * (1 - Math.exp(-offset / 60)) : offset
								const elapsed = Math.max(1, event.timeStamp - gesture.time)
								gesture.velocity = ((x - sheetX.get()) / elapsed) * 1000
								gesture.time = event.timeStamp
								sheetX.jump(x)
							}}
							onPointerUp={endSwipe}
							onPointerCancel={endSwipe}
						>
							<Tooltip.Provider delay={250} timeout={300}>
								{sidebar}
							</Tooltip.Provider>
						</motion.div>
					</>,
					document.body,
				)}
			</SidebarState>
		</>
	)
}

type SidebarSectionProps = {
	title?: string
	open?: boolean
	onOpenChange?: (open: boolean) => void
	children: ReactNode
}

export function SidebarSection({ title, open = true, onOpenChange, children }: SidebarSectionProps) {
	const { rail, reduce } = useContext(SidebarState)
	const id = useId()
	const listId = useId()
	// The rail has no room for the toggle, so a closed section still shows its icons there.
	const expanded = open || rail
	const label = (
		<span
			className={cn(
				'absolute bottom-[9px] left-[9px] flex items-center gap-1 leading-none whitespace-nowrap',
				railFade,
			)}
		>
			{title}
			{onOpenChange && (
				<IconCaretDownFilled
					size={12}
					aria-hidden='true'
					className={cn('transition-transform duration-170 ease-standard', !open && '-rotate-90')}
				/>
			)}
		</span>
	)
	return (
		<section aria-labelledby={title ? id : undefined} className='grid min-w-0 grid-cols-[minmax(0,1fr)]'>
			{title && (
				<motion.h2
					id={id}
					className='relative m-0 h-[46px] overflow-hidden text-xs font-medium text-muted'
					initial={false}
					animate={{ height: rail ? 17 : 46 }}
					transition={reduce ? instant : spring.smooth}
				>
					{onOpenChange ? (
						<button
							type='button'
							aria-expanded={open}
							aria-controls={listId}
							tabIndex={rail ? -1 : undefined}
							onClick={() => onOpenChange(!open)}
							className='absolute inset-x-0 top-4 bottom-0 rounded-control [-webkit-tap-highlight-color:transparent] group-data-rail/sidebar:pointer-events-none hover:text-foreground'
						>
							{label}
						</button>
					) : (
						label
					)}
					<span
						aria-hidden='true'
						className={cn('absolute inset-x-2 top-2 h-px scale-x-30 bg-border', railShow)}
					/>
				</motion.h2>
			)}
			<ul id={listId} className='relative m-0 grid grid-cols-[minmax(0,1fr)] p-0'>
				<AnimatePresence initial={false}>{expanded && children}</AnimatePresence>
			</ul>
		</section>
	)
}

type SidebarLinkProps = {
	to: string
	params?: Record<string, string>
	search?: Record<string, string | undefined>
	exact?: boolean
	label: string
	icon: ReactNode
	count?: number
}

export function SidebarLink({ to, params, search, exact = false, label, icon, count }: SidebarLinkProps) {
	const { reduce, drawer } = useContext(SidebarState)
	return (
		<SidebarItem label={label} note={count ? String(count) : undefined}>
			<Link
				draggable={false}
				to={to}
				params={params}
				search={search}
				activeOptions={{ exact, includeSearch: false }}
				// The drawer's exit is the motion; a page swap would freeze it in the snapshot.
				viewTransition={drawer ? false : undefined}
				className={rowClass}
			>
				{({ isActive }) => (
					<>
						{isActive && <ActiveHighlight reduce={reduce} />}
						<span className={leadClass}>{icon}</span>
						<span className={nameClass}>{label}</span>
						{count ? (
							<span className={cn('relative z-1 text-xs text-muted tabular-nums', railFade)}>
								{count}
							</span>
						) : null}
					</>
				)}
			</Link>
		</SidebarItem>
	)
}

/** A row that is not a link: a loading line or a retry, still folding with its section. */
export function SidebarItem({ label, note, children }: { label?: string; note?: string; children: ReactElement }) {
	const { rail, reduce } = useContext(SidebarState)
	return (
		<motion.li
			className='relative mt-px min-w-0 rounded-control'
			initial={folded}
			animate={unfolded}
			exit={folded}
			transition={reduce ? instant : fold}
		>
			{label ? (
				<RailTip enabled={rail} label={label} note={note}>
					{children}
				</RailTip>
			) : (
				children
			)}
		</motion.li>
	)
}

function ActiveHighlight({ reduce }: { reduce: boolean }) {
	return (
		<motion.span
			layoutId='active'
			aria-hidden='true'
			className='absolute inset-0 z-0 rounded-control bg-(--row-active)'
			transition={reduce ? instant : spring.morph}
		/>
	)
}

function RailIcon({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) {
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
				transition={reduce ? instant : spring.smooth}
			/>
		</svg>
	)
}

// Rail tooltips name what the icon rail hides; outside the rail they stay closed.
function RailTip({
	enabled,
	label,
	note,
	shortcut,
	side = 'right',
	children,
}: {
	enabled: boolean
	label: string
	note?: string
	shortcut?: string
	side?: 'right' | 'bottom'
	children: ReactElement
}) {
	const [open, setOpen] = useState(false)
	if (!enabled && open) setOpen(false)
	return (
		<Tooltip.Root open={enabled && open} onOpenChange={next => setOpen(next && enabled)}>
			<Tooltip.Trigger render={children} />
			<Tooltip.Portal>
				<Tooltip.Positioner
					side={side}
					sideOffset={side === 'right' ? 14 : 8}
					collisionPadding={8}
					className='z-60'
				>
					<Tooltip.Popup className='flex items-center gap-2 rounded-control border border-border-strong bg-surface-raised px-2 py-1 font-sans text-xs font-medium whitespace-nowrap text-secondary shadow-raised transition-[opacity,translate] duration-110 ease-enter data-ending-style:-translate-x-0.5 data-ending-style:opacity-0 data-ending-style:duration-85 data-starting-style:-translate-x-1 data-starting-style:opacity-0 data-instant:data-starting-style:translate-none data-[side=bottom]:data-ending-style:translate-x-0 data-[side=bottom]:data-ending-style:-translate-y-0.5 data-[side=bottom]:data-starting-style:translate-x-0 data-[side=bottom]:data-starting-style:-translate-y-1'>
						{label}
						{note && <span className='font-normal text-muted'>{note}</span>}
						{shortcut && (
							<kbd className='inline-grid h-5 min-w-5 place-items-center rounded-[6px] border border-border-strong px-[5px] font-sans text-xs leading-none font-normal'>
								{shortcut}
							</kbd>
						)}
					</Tooltip.Popup>
				</Tooltip.Positioner>
			</Tooltip.Portal>
		</Tooltip.Root>
	)
}
