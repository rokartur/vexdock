import { createContext, type RefObject, useContext, useLayoutEffect, useRef, useState } from 'react'
import { Tabs as BaseTabs } from '@base-ui/react/tabs'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import { type AnimationPlaybackControls, animate, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

type TabsProps = Omit<BaseTabs.Root.Props, 'value' | 'defaultValue' | 'onValueChange' | 'className'> & {
	value?: string
	defaultValue?: string
	onValueChange?: (value: string) => void
	className?: string
}
type TabsListProps = Omit<BaseTabs.List.Props, 'className'> & { className?: string }
type TabsTriggerProps = Omit<BaseTabs.Tab.Props, 'value' | 'className'> & {
	value: string
	className?: string
	// vexdock: makes the tab a router link; the URL owns which tab is active, through the value passed to Tabs.
	href?: string
}
type TabsContentProps = Omit<BaseTabs.Panel.Props, 'value' | 'className'> & {
	value: string
	className?: string
}

// `panelHeightRef` holds the visible panel height so the next panel can morph from it; `leavingRectRef` pins the outgoing panel where it was on screen.
const TabsContext = createContext<{
	active: string
	activePanelRef: RefObject<HTMLDivElement | null>
	panelHeightRef: RefObject<number | null>
	leavingRectRef: RefObject<DOMRect | null>
}>({
	active: '',
	activePanelRef: { current: null },
	panelHeightRef: { current: null },
	leavingRectRef: { current: null },
})

// Room for the scroll button on an edge that can still scroll, so a revealed tab is not left under it.
const EDGE_BUTTON = 34
// surface-muted is a tint here, so it sits on bg-background to paint the shell's color and hide the tabs scrolled under it.
const scrollButton =
	'absolute inset-y-0 z-2 grid w-[33px] place-items-center bg-background text-foreground transition-none before:absolute before:inset-0 before:rounded-[inherit] before:bg-surface-muted focus-visible:[--focus-outline-offset:-3px] disabled:pointer-events-none disabled:opacity-0'

export function Tabs({ value, defaultValue, onValueChange, className, ...props }: TabsProps) {
	const [internal, setInternal] = useState(defaultValue ?? '')
	const active = value ?? internal
	const activePanelRef = useRef<HTMLDivElement>(null)
	const panelHeightRef = useRef<number | null>(null)
	const leavingRectRef = useRef<DOMRect | null>(null)

	function handleChange(next: string) {
		leavingRectRef.current = activePanelRef.current?.getBoundingClientRect() ?? null
		if (value === undefined) setInternal(next)
		onValueChange?.(next)
	}

	return (
		<TabsContext.Provider value={{ active, activePanelRef, panelHeightRef, leavingRectRef }}>
			<BaseTabs.Root
				{...props}
				className={cn('relative', className)}
				value={active}
				onValueChange={handleChange}
			/>
		</TabsContext.Provider>
	)
}

export function TabsList({ className, children, ...props }: TabsListProps) {
	const { active } = useContext(TabsContext)
	const reduced = useReducedMotion() ?? false
	const shellRef = useRef<HTMLDivElement>(null)
	const viewportRef = useRef<HTMLDivElement>(null)
	const listRef = useRef<HTMLDivElement>(null)
	const [edges, setEdges] = useState({ overflow: false, left: false, right: false })

	useLayoutEffect(() => {
		const shell = shellRef.current
		const viewport = viewportRef.current
		const list = listRef.current
		if (!shell || !viewport || !list) return
		function update() {
			if (!shell || !viewport) return
			const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
			const next = {
				overflow: viewport.scrollWidth > shell.clientWidth + 1,
				left: viewport.scrollLeft > 1,
				right: viewport.scrollLeft < max - 1,
			}
			setEdges(previous =>
				previous.overflow === next.overflow && previous.left === next.left && previous.right === next.right
					? previous
					: next,
			)
		}
		const observer = new ResizeObserver(update)
		observer.observe(shell)
		observer.observe(viewport)
		observer.observe(list)
		viewport.addEventListener('scroll', update, { passive: true })
		update()
		return () => {
			observer.disconnect()
			viewport.removeEventListener('scroll', update)
		}
	}, [])

	useLayoutEffect(() => {
		const viewport = viewportRef.current
		const tab = listRef.current?.querySelector<HTMLElement>('[role="tab"][data-active]')
		if (viewport && tab) revealTab(viewport, tab, reduced)
	}, [active, reduced])

	function scrollTabs(direction: number) {
		const viewport = viewportRef.current
		if (!viewport) return
		viewport.scrollBy({
			left: direction * viewport.clientWidth * 0.75,
			behavior: reduced ? 'instant' : 'smooth',
		})
	}

	return (
		<div
			ref={shellRef}
			data-overflow={edges.overflow}
			data-left={edges.left}
			data-right={edges.right}
			className='group/shell relative isolate inline-flex max-w-full min-w-0 items-center rounded-control border border-border bg-surface-muted'
		>
			{edges.overflow && (
				<button
					type='button'
					aria-label='Scroll tabs left'
					disabled={!edges.left}
					onClick={() => scrollTabs(-1)}
					className={cn(scrollButton, 'left-0 rounded-l-control')}
				>
					<IconChevronLeft size={16} stroke={1.75} aria-hidden className='relative' />
				</button>
			)}
			<div
				ref={viewportRef}
				onFocusCapture={event => {
					const { target } = event
					if (target instanceof HTMLElement && target.getAttribute('role') === 'tab') {
						revealTab(event.currentTarget, target, reduced)
					}
				}}
				className={cn(
					'min-w-0 [scrollbar-width:none] overflow-x-auto rounded-[inherit] [&::-webkit-scrollbar]:hidden',
					'group-data-[left=true]/shell:[mask-image:linear-gradient(to_right,transparent,black_35px,black)]',
					'group-data-[right=true]/shell:[mask-image:linear-gradient(to_right,black,black_calc(100%-35px),transparent)]',
					'group-data-[left=true]/shell:group-data-[right=true]/shell:[mask-image:linear-gradient(to_right,transparent,black_35px,black_calc(100%-35px),transparent)]',
				)}
			>
				<BaseTabs.List
					{...props}
					ref={listRef}
					activateOnFocus
					className={cn('relative isolate inline-flex w-max items-center gap-0.75 p-0.75', className)}
				>
					{children}
					<BaseTabs.Indicator
						renderBeforeHydration
						className='absolute top-(--active-tab-top) left-0 -z-1 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) rounded-[calc(var(--radius-control)-3px)] border border-border bg-surface shadow-resting transition-[translate,width] duration-400 ease-spring'
					/>
				</BaseTabs.List>
			</div>
			{edges.overflow && (
				<button
					type='button'
					aria-label='Scroll tabs right'
					disabled={!edges.right}
					onClick={() => scrollTabs(1)}
					className={cn(scrollButton, 'right-0 rounded-r-control')}
				>
					<IconChevronRight size={16} stroke={1.75} aria-hidden className='relative' />
				</button>
			)}
		</div>
	)
}

export function TabsTrigger({ className, children, href, ...props }: TabsTriggerProps) {
	return (
		<BaseTabs.Tab
			{...props}
			nativeButton={href === undefined}
			render={href === undefined ? undefined : <Link to={href} activeOptions={{ exact: true }} />}
			// vexdock: no min-w-22, each tab fits its label so a ten-tab strip keeps even gaps; the label row holds a count.
			className={cn(
				'relative inline-grid min-h-control-sm flex-none place-items-center rounded-[calc(var(--radius-control)-3px)] px-2.5 text-sm font-medium whitespace-nowrap text-muted transition-colors hover:text-foreground active:text-foreground data-active:text-accent-strong data-disabled:opacity-50',
				className,
			)}
		>
			<span className='relative z-1 inline-flex items-center gap-1.5'>{children}</span>
		</BaseTabs.Tab>
	)
}

export function TabsContent({ className, value, keepMounted, ...props }: TabsContentProps) {
	const { active, activePanelRef, panelHeightRef, leavingRectRef } = useContext(TabsContext)
	const reduced = useReducedMotion() ?? false
	const panelRef = useRef<HTMLDivElement>(null)
	const selected = active === value

	// The incoming panel starts at the outgoing panel's height and settles at its own, so content below glides instead of jumping.
	useLayoutEffect(() => {
		const node = panelRef.current
		if (!node || keepMounted) return
		if (!selected) {
			const before = leavingRectRef.current
			node.inert = true
			if (reduced) animate(node, { opacity: [1, 0] }, { duration: 0.07 })
			node.style.position = 'absolute'
			node.style.marginTop = '0px'
			const root = node.offsetParent
			if (!before || !root) return
			const frame = root.getBoundingClientRect()
			Object.assign(node.style, {
				top: `${before.top - frame.top}px`,
				left: `${before.left - frame.left}px`,
				width: `${before.width}px`,
			})
			return
		}
		Object.assign(node.style, { position: '', top: '', left: '', width: '', marginTop: '' })
		node.inert = false
		activePanelRef.current = node
		const from = panelHeightRef.current
		// The styles.css kill switch zeroes CSS transitions; Arc still crossfades panels under reduced motion.
		if (reduced && from !== null) {
			animate(node, { opacity: [0, 1] }, { duration: motionTokens.duration.instant })
		}
		const to = node.offsetHeight
		let controls: AnimationPlaybackControls | undefined
		const release = () => {
			node.style.height = ''
			node.style.overflow = ''
		}
		if (from !== null && Math.abs(from - to) > 1 && !reduced) {
			if (to > from) node.style.overflow = 'clip'
			controls = animate(node, { height: [from, to] }, { ...motionTokens.spring.smooth, onComplete: release })
		}
		panelHeightRef.current = controls && from !== null ? from : to
		const observer = new ResizeObserver(() => {
			panelHeightRef.current = node.offsetHeight
		})
		observer.observe(node)
		return () => {
			observer.disconnect()
			controls?.stop()
			release()
		}
	}, [selected, reduced, keepMounted, activePanelRef, panelHeightRef, leavingRectRef])

	// Enter runs from @starting-style so it moves on the first frame, as Arc's motion panel does; ease-spring at 400ms tracks spring.smooth.
	return (
		<BaseTabs.Panel
			{...props}
			ref={panelRef}
			value={value}
			keepMounted={keepMounted}
			className={cn(
				'mt-3 text-sm text-secondary focus-visible:rounded-control focus-visible:[--focus-outline-offset:3px]',
				!keepMounted && [
					'[transition:opacity_170ms_var(--ease-enter),translate_400ms_var(--ease-spring)]',
					'not-data-[activation-direction=none]:starting:opacity-0 data-[activation-direction=left]:starting:-translate-x-2 data-[activation-direction=right]:starting:translate-x-2',
					'data-ending-style:opacity-0 data-ending-style:[transition:opacity_85ms_var(--ease-standard),translate_85ms_var(--ease-standard)] data-[activation-direction=left]:data-ending-style:translate-x-1.5 data-[activation-direction=right]:data-ending-style:-translate-x-1.5',
				],
				className,
			)}
		/>
	)
}

function revealTab(viewport: HTMLElement, tab: HTMLElement, reduced: boolean) {
	const frame = viewport.getBoundingClientRect()
	const item = tab.getBoundingClientRect()
	const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
	const left = frame.left + (viewport.scrollLeft > 1 ? EDGE_BUTTON : 0)
	const right = frame.right - (viewport.scrollLeft < max - 1 ? EDGE_BUTTON : 0)
	let delta = 0
	if (item.left < left) delta = item.left - left
	else if (item.right > right) delta = item.right - right
	if (delta) viewport.scrollBy({ left: delta, behavior: reduced ? 'instant' : 'smooth' })
}
