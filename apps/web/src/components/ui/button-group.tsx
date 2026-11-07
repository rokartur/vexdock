import {
	type CSSProperties,
	type FocusEvent,
	isValidElement,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'
import { Menu } from '@base-ui/react/menu'
import type { BaseUIEvent } from '@base-ui/react/types'
import { IconChevronDown } from '@tabler/icons-react'
import { cn } from 'cn'
import {
	AnimatePresence,
	animate,
	motion,
	type TargetAndTransition,
	useMotionValue,
	useReducedMotion,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type ButtonGroupItem = {
	id: string
	label: string
	reserve?: string[]
	icon?: ReactNode
	iconOnly?: boolean
	content?: ReactNode
	onSelect?: () => void
	href?: string
	disabled?: boolean
	// vexdock: makes the segment a toggle (follow, wrap) and draws it held down while true.
	pressed?: boolean
}

export type ButtonGroupMenuItem = {
	id: string
	label: string
	icon?: ReactNode
	onSelect?: () => void
	href?: string
	disabled?: boolean
	destructive?: boolean
}

export type ButtonGroupProps = {
	items: ButtonGroupItem[]
	label: string
	menu?: { label: string; items: ButtonGroupMenuItem[] }
	variant?: keyof typeof variants
	size?: keyof typeof sizes
	orientation?: 'horizontal' | 'vertical'
	collapseLabels?: boolean
	disabled?: boolean
	className?: string
	style?: CSSProperties
}

// Plain text, because the HTML parser rewrites control characters in server-rendered attributes.
const MENU = 'button-group-menu'

const { blur, duration, ease, spring } = motionTokens
const rest: TargetAndTransition = { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }
const textIn: TargetAndTransition = { opacity: 0, y: 4, filter: `blur(${blur.soft}px)` }
const textOut: TargetAndTransition = {
	opacity: 0,
	y: -3,
	filter: `blur(${blur.soft}px)`,
	transition: { duration: duration.fast, ease: [...ease.standard] },
}
const fadeIn: TargetAndTransition = { ...rest, opacity: 0 }
const fadeOut: TargetAndTransition = { opacity: 0, transition: { duration: duration.instant } }

const variants = {
	outline:
		'border-border bg-surface text-foreground [--divider:var(--border)] [--highlight-pressed:color-mix(in_oklab,var(--surface-muted),var(--border-strong)_30%)] [--highlight:var(--surface-muted)] [--muted-ink:var(--text-secondary)]',
	solid: 'border-foreground bg-foreground text-background [--divider:color-mix(in_oklab,var(--background)_20%,var(--foreground))] [--highlight-pressed:color-mix(in_oklab,var(--background)_22%,var(--foreground))] [--highlight:color-mix(in_oklab,var(--background)_13%,var(--foreground))] [--muted-ink:color-mix(in_oklab,var(--background)_72%,var(--foreground))]',
}

const sizes = {
	sm: '[--divider-inset:7px] [--pad-x:--spacing(2.5)] [--phase-gap:5px] [--segment:calc(var(--spacing-control-sm)-2px)]',
	md: '[--divider-inset:9px] [--pad-x:--spacing(3)] [--phase-gap:--spacing(1.5)] [--segment:calc(var(--spacing-control-md)-2px)]',
}

const dividers = {
	horizontal: 'before:inset-y-(--divider-inset) before:left-[-0.5px] before:w-px',
	vertical: 'before:inset-x-2 before:top-[-0.5px] before:h-px',
}

const segmentBase =
	'group/segment relative z-1 inline-flex h-(--segment) min-w-(--segment) flex-none items-center justify-center px-(--pad-x) text-sm leading-none font-medium whitespace-nowrap before:pointer-events-none before:absolute before:bg-(--divider) before:transition-opacity before:duration-110 before:ease-standard data-quiet:before:opacity-0'

const pressedContent =
	'relative inline-flex items-center transition-[scale,opacity] [transition-duration:400ms,110ms] [transition-timing-function:var(--ease-spring),var(--ease-standard)] group-active/segment:[transition-duration:85ms] group-active/segment:[transition-timing-function:var(--ease-standard)] group-aria-disabled/segment:opacity-40'

export function ButtonGroup({
	items,
	label,
	menu,
	variant = 'outline',
	size = 'md',
	orientation = 'horizontal',
	collapseLabels = true,
	disabled = false,
	className,
	style,
}: ButtonGroupProps) {
	const reduced = useReducedMotion() ?? false
	const root = useRef<HTMLDivElement>(null)
	const vertical = orientation === 'vertical'

	// The highlight sits on the pointer's segment, else the pressed one (touch), else the open menu's chevron, else keyboard focus.
	const [hover, setHover] = useState<string | null>(null)
	const [pressed, setPressed] = useState<string | null>(null)
	const [focused, setFocused] = useState<string | null>(null)
	const [menuOpen, setMenuOpen] = useState(false)
	const active = hover ?? pressed ?? (menuOpen ? MENU : null) ?? focused
	const keys = [...items.map(item => item.id), ...(menu ? [MENU] : [])]
	const activeIndex = active === null ? -1 : keys.indexOf(active)
	const inertKey = `${disabled}${items.map(item => (item.disabled ? 1 : 0)).join('')}`

	const x = useMotionValue(0)
	const y = useMotionValue(0)
	const width = useMotionValue(0)
	const height = useMotionValue(0)
	const opacity = useMotionValue(0)
	const shown = useRef<string | null>(null)

	useLayoutEffect(() => {
		const group = root.current!
		const node = segmentIn(group, active)
		// Hovering a disabled segment shows nothing; focus on one still shows where the keyboard is.
		if (!node || (isInert(node) && active !== focused)) {
			if (shown.current) {
				animate(opacity, 0, {
					duration: reduced ? duration.instant : duration.fast,
					ease: [...ease.standard],
				})
			}
			shown.current = null
			return
		}
		const target = boxOf(group, node)
		const values = [x, y, width, height]
		if (!shown.current || reduced) {
			// Arriving from outside the group it appears in place; only moves between segments travel.
			values.forEach((value, index) => value.jump(target[index]!))
			animate(opacity, 1, {
				duration: reduced ? duration.instant : duration.fast,
				ease: [...ease.standard],
			})
		} else {
			values.forEach((value, index) => animate(value, target[index]!, spring.snappy))
			animate(opacity, 1, { duration: duration.fast })
		}
		shown.current = active
		// inertKey re-checks a segment that turns disabled under a still pointer.
	}, [active, focused, inertKey, reduced, x, y, width, height, opacity])

	// Segments resize when a label springs or labels collapse; the highlight stays locked to its segment.
	const keyList = keys.join(' ')
	useEffect(() => {
		const group = root.current!
		const observer = new ResizeObserver(() => {
			const node = segmentIn(group, shown.current)
			if (!node) return
			const target = boxOf(group, node)
			;[x, y, width, height].forEach((value, index) => {
				if (Math.abs(value.get() - target[index]!) < 0.01) return
				if (value.isAnimating() && !reduced) animate(value, target[index]!, spring.snappy)
				else value.jump(target[index]!)
			})
		})
		observer.observe(group)
		for (const node of segmentsIn(group)) observer.observe(node)
		return () => observer.disconnect()
	}, [keyList, reduced, x, y, width, height])

	// Labels collapse to icons when the row overflows, and come back once the container fits the full row again.
	const [overflowing, setOverflowing] = useState(false)
	const fullWidth = useRef(0)
	const blockedAt = useRef(0)
	const collapsible =
		collapseLabels && !vertical && items.some(item => item.icon && !item.iconOnly && item.content === undefined)
	const compact = collapsible && overflowing
	useEffect(() => {
		if (!collapsible) return
		const group = root.current!
		const parent = group.parentElement!
		const check = () => {
			const box = getComputedStyle(parent)
			const available = parent.clientWidth - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight)
			if (group.dataset.compact === undefined) {
				if (group.scrollWidth <= group.clientWidth + 1) return
				fullWidth.current = group.scrollWidth + 2
				blockedAt.current = available
				setOverflowing(true)
			} else if (available > blockedAt.current && available >= fullWidth.current) {
				setOverflowing(false)
			}
		}
		const observer = new ResizeObserver(check)
		observer.observe(group)
		observer.observe(parent)
		return () => observer.disconnect()
	}, [collapsible, keyList])

	// Pressing tracks the segment under the finger, so touch gets the highlight a pointer gets on hover.
	useEffect(() => {
		if (!pressed) return
		const release = () => setPressed(null)
		window.addEventListener('pointerup', release)
		window.addEventListener('pointercancel', release)
		return () => {
			window.removeEventListener('pointerup', release)
			window.removeEventListener('pointercancel', release)
		}
	}, [pressed])

	// A label that changes within a second of its press ("Share" to "Copied") is announced once; the quiet revert is not.
	const [announcement, setAnnouncement] = useState('')
	const labels = useRef<Map<string, string>>(null)
	const activated = useRef({ key: '', at: 0 })
	const labelList = items.map(item => `${item.id} ${item.label}`).join('\n')
	useEffect(() => {
		const previous = labels.current
		labels.current = new Map(items.map(item => [item.id, item.label]))
		if (!previous) return
		if (performance.now() - activated.current.at >= 1000) return
		const changed = items.filter(
			item =>
				item.id === activated.current.key &&
				previous.has(item.id) &&
				previous.get(item.id) !== item.label &&
				item.content === undefined,
		)
		if (changed.length) setAnnouncement(changed.map(item => item.label).join(', '))
		// labelList carries the only part of items this effect reads.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [labelList])

	function select(item: ButtonGroupItem) {
		activated.current = { key: item.id, at: performance.now() }
		item.onSelect?.()
	}

	function hit(event: PointerEvent) {
		for (const node of segmentsIn(root.current!)) {
			const rect = node.getBoundingClientRect()
			const inside =
				event.clientX >= rect.left &&
				event.clientX < rect.right &&
				event.clientY >= rect.top &&
				event.clientY < rect.bottom
			if (inside) return isInert(node) ? null : (node.dataset.key ?? null)
		}
		return null
	}

	function onPointerMove(event: PointerEvent<HTMLDivElement>) {
		if (event.pointerType !== 'touch') setHover(hit(event))
	}

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		if (event.button === 0) setPressed(hit(event))
	}

	// Keyboard focus shows the highlight; a mouse click focuses without it, so nothing stays lit after the pointer leaves.
	function onFocus(event: FocusEvent<HTMLDivElement>) {
		const key = event.target.dataset.key
		if (key === undefined) return
		setFocused(event.target.matches(':focus-visible') ? key : null)
	}

	function onBlur(event: FocusEvent<HTMLDivElement>) {
		if (!root.current!.contains(event.relatedTarget)) setFocused(null)
	}

	// Disabled segments stay focusable (aria-disabled), so the keyboard finds them and hears why nothing happens.
	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.defaultPrevented) return
		const list = segmentsIn(root.current!).filter(node => !node.matches(':disabled'))
		const index = list.findIndex(node => node === document.activeElement)
		if (index < 0) return
		const rtl = !vertical && getComputedStyle(root.current!).direction === 'rtl'
		const forward = vertical ? 'ArrowDown' : rtl ? 'ArrowLeft' : 'ArrowRight'
		const backward = vertical ? 'ArrowUp' : rtl ? 'ArrowRight' : 'ArrowLeft'
		const last = list.length - 1
		let target = -1
		if (event.key === forward) target = index === last ? 0 : index + 1
		if (event.key === backward) target = index === 0 ? last : index - 1
		if (event.key === 'Home') target = 0
		if (event.key === 'End') target = last
		if (target < 0) return
		event.preventDefault()
		list[target]!.focus()
	}

	const quiet = (index: number) =>
		activeIndex >= 0 && (index === activeIndex || index === activeIndex + 1) ? '' : undefined

	const group = (
		<div
			ref={root}
			role='group'
			aria-label={label}
			aria-disabled={disabled || undefined}
			data-orientation={orientation}
			data-compact={compact ? '' : undefined}
			style={style}
			className={cn(
				'relative isolate inline-flex max-w-full [scrollbar-width:none] items-stretch overflow-x-auto overscroll-x-contain rounded-control border align-middle aria-disabled:opacity-52 [&::-webkit-scrollbar]:hidden',
				variants[variant],
				sizes[size],
				vertical && 'flex-col overflow-visible',
				className,
			)}
			onPointerMove={onPointerMove}
			onPointerLeave={() => setHover(null)}
			onPointerDown={onPointerDown}
			onFocus={onFocus}
			onBlur={onBlur}
			onKeyDown={onKeyDown}
		>
			<motion.span
				aria-hidden='true'
				data-pressed={pressed !== null && pressed === active ? '' : undefined}
				// vexdock: over a held toggle the highlight takes the held fill, or hovering it would read as off.
				data-held={items.some(item => item.id === active && item.pressed) ? '' : undefined}
				style={{ x, y, width, height, opacity }}
				className="pointer-events-none absolute top-0 left-0 z-0 before:absolute before:inset-[3px] before:rounded-[calc(var(--radius-control)-4px)] before:bg-(--highlight) before:transition-colors before:duration-110 before:ease-standard before:content-[''] data-held:before:bg-(--highlight-pressed) data-pressed:before:bg-(--highlight-pressed) data-pressed:before:duration-85"
			/>
			{items.map((item, index) => {
				const off = item.disabled && !disabled
				const hasLabel = item.icon !== undefined && !item.iconOnly && item.content === undefined
				const collapsed = compact && hasLabel
				const named = item.iconOnly || item.content !== undefined || collapsed
				const square = item.iconOnly || collapsed
				const segment = {
					'data-key': item.id,
					'data-quiet': quiet(index),
					'aria-label': named ? item.label : undefined,
					title: square ? item.label : undefined,
					className: cn(
						segmentBase,
						index > 0 && dividers[orientation],
						square && 'w-(--segment) px-0',
						vertical && 'w-full justify-start',
						vertical && item.iconOnly && 'justify-center px-0',
					),
				}
				const body = (
					<>
						<span
							className={cn(
								pressedContent,
								item.iconOnly
									? 'motion-safe:group-active/segment:group-not-aria-disabled/segment:scale-90'
									: 'motion-safe:group-active/segment:group-not-aria-disabled/segment:scale-97',
							)}
						>
							<SegmentContent item={item} collapsed={collapsed} reduced={reduced} />
						</span>
						{!named && <span className='sr-only'>{item.label}</span>}
					</>
				)
				if (item.href && !off && !disabled) {
					return (
						<a key={item.id} href={item.href} onClick={() => select(item)} {...segment}>
							{body}
						</a>
					)
				}
				return (
					<button
						key={item.id}
						type='button'
						disabled={disabled}
						aria-disabled={off || undefined}
						aria-pressed={item.pressed}
						onClick={off ? undefined : () => select(item)}
						{...segment}
						className={cn(
							segment.className,
							// vexdock: the held fill is always drawn, so pressing a toggle fades it in and out.
							item.pressed !== undefined &&
								"after:pointer-events-none after:absolute after:inset-[3px] after:-z-1 after:rounded-[calc(var(--radius-control)-4px)] after:transition-colors after:content-[''] aria-pressed:after:bg-(--highlight-pressed)",
						)}
					>
						{body}
					</button>
				)
			})}
			{menu && (
				<Menu.Trigger
					data-key={MENU}
					data-quiet={quiet(items.length)}
					aria-label={menu.label}
					title={menu.label}
					disabled={disabled}
					className={cn(
						segmentBase,
						items.length > 0 && dividers[orientation],
						'w-[calc(var(--segment)-4px)] min-w-0 px-0 text-(--muted-ink) transition-colors duration-110 ease-standard data-popup-open:text-inherit',
						vertical && 'w-full',
					)}
				>
					<span className='relative inline-flex items-center'>
						<IconChevronDown
							size={16}
							stroke={1.75}
							aria-hidden='true'
							className='transition-[rotate] duration-400 ease-spring group-data-popup-open/segment:rotate-180'
						/>
					</span>
				</Menu.Trigger>
			)}
			<span className='sr-only' aria-live='polite'>
				{announcement}
			</span>
		</div>
	)

	if (!menu) return group
	// Non-modal: no scroll lock, so opening the menu never shifts the page by a scrollbar's width.
	return (
		<Menu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
			{group}
			<Menu.Portal>
				<Menu.Positioner
					side='bottom'
					align={vertical ? 'start' : 'end'}
					alignOffset={-1}
					sideOffset={6}
					collisionPadding={12}
					className='z-60'
				>
					<Menu.Popup
						onKeyDown={moveToEnabledItem}
						className='max-w-(--available-width) min-w-[min(13rem,var(--available-width))] origin-(--transform-origin) rounded-panel border bg-surface-raised p-1 text-foreground shadow-floating transition-[opacity,translate,scale] [transition-duration:110ms,400ms,400ms] [transition-timing-function:var(--ease-enter),var(--ease-spring),var(--ease-spring)] [--menu-x:0px] [--menu-y:-5px] data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-85 data-ending-style:ease-standard data-starting-style:opacity-0 data-[side=left]:[--menu-x:5px] data-[side=left]:[--menu-y:0px] data-[side=right]:[--menu-x:-5px] data-[side=right]:[--menu-y:0px] data-[side=top]:[--menu-y:5px] motion-safe:data-ending-style:translate-x-[calc(var(--menu-x)*0.5)] motion-safe:data-ending-style:translate-y-[calc(var(--menu-y)*0.5)] motion-safe:data-ending-style:scale-[0.985] motion-safe:data-starting-style:translate-x-(--menu-x) motion-safe:data-starting-style:translate-y-(--menu-y) motion-safe:data-starting-style:scale-97'
					>
						{menu.items.map((action, index) => {
							const itemProps = {
								disabled: action.disabled,
								onClick: action.onSelect,
								style: { transitionDelay: `${Math.min(index, 4) * 25}ms` },
								className: cn(
									'flex min-h-8 items-center gap-2.5 rounded-[calc(var(--radius-panel)-6px)] px-2.5 text-sm text-inherit transition-[opacity,translate] duration-170 ease-enter data-disabled:opacity-45 not-data-disabled:data-highlighted:bg-surface-muted starting:opacity-0 motion-safe:starting:translate-x-[calc(var(--menu-x)*0.4)] motion-safe:starting:translate-y-[calc(var(--menu-y)*0.4)]',
									action.destructive &&
										'text-danger not-data-disabled:data-highlighted:bg-[color-mix(in_oklab,var(--danger)_8%,var(--surface))]',
								),
							}
							const body = (
								<>
									{action.icon && (
										<span
											aria-hidden='true'
											className={cn(
												'inline-flex flex-none [&_svg]:size-4 [&_svg]:stroke-[1.75]',
												action.destructive ? 'text-danger' : 'text-secondary',
											)}
										>
											{action.icon}
										</span>
									)}
									{/* vexdock: leading-normal, the segment's leading-none clips descenders under truncate. */}
									<span className='min-w-0 truncate leading-normal'>{action.label}</span>
								</>
							)
							return action.href ? (
								<Menu.LinkItem key={action.id} href={action.href} {...itemProps}>
									{body}
								</Menu.LinkItem>
							) : (
								<Menu.Item key={action.id} {...itemProps}>
									{body}
								</Menu.Item>
							)
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}

// Every reserved label sits invisibly in the same grid cell, so the segment is as wide as its widest state and a new
// label crossfades inside a fixed box. A label nobody reserved still never snaps: the slot springs to its width.
function SegmentContent({ item, collapsed, reduced }: { item: ButtonGroupItem; collapsed: boolean; reduced: boolean }) {
	const contentRef = useRef<HTMLSpanElement>(null)
	const showsLabel = !item.iconOnly && item.content === undefined
	const key = `${iconKey(item.icon)}|${item.content !== undefined ? 'content' : item.iconOnly ? '' : item.label}`
	const width = useMorphWidth(contentRef, key, reduced)
	const sizers = showsLabel ? [...new Set([item.label, ...(item.reserve ?? [])])] : []
	const labelClass = cn('inline-block', collapsed && 'hidden')

	return (
		<motion.span
			aria-hidden='true'
			style={{ width }}
			className='relative inline-flex min-w-0 items-center justify-center data-morphing:[clip-path:inset(-50%_calc(var(--spacing)*-3))]'
		>
			<span
				ref={contentRef}
				className='inline-grid flex-none items-center justify-items-center *:col-start-1 *:row-start-1'
			>
				{sizers.map(text => (
					<span
						key={text}
						className='pointer-events-none invisible inline-flex items-center gap-(--phase-gap) whitespace-nowrap'
					>
						{item.icon && <span className='inline-block size-4 flex-none' />}
						<span className={labelClass}>{text}</span>
					</span>
				))}
				<AnimatePresence initial={false}>
					<motion.span
						key={key}
						initial={reduced ? fadeIn : textIn}
						animate={rest}
						exit={reduced ? fadeOut : textOut}
						transition={
							reduced
								? { duration: duration.instant }
								: { duration: duration.standard, ease: [...ease.enter] }
						}
						className='inline-flex items-center gap-(--phase-gap) whitespace-nowrap'
					>
						{item.icon && (
							<span className='inline-flex flex-none [&_svg]:size-4 [&_svg]:stroke-[1.75]'>
								{item.icon}
							</span>
						)}
						{item.content !== undefined ? (
							<span className='inline-flex items-center tabular-nums'>{item.content}</span>
						) : (
							showsLabel && <span className={labelClass}>{item.label}</span>
						)}
					</motion.span>
				</AnimatePresence>
			</span>
		</motion.span>
	)
}

// Springs the slot to the natural width of its content when the label changes; other resizes (a late web font,
// collapsing labels) jump.
function useMorphWidth(content: RefObject<HTMLElement | null>, key: string, reduced: boolean) {
	const width = useMotionValue<number | 'auto'>('auto')
	const lastKey = useRef(key)
	const armedUntil = useRef(0)

	useLayoutEffect(() => {
		if (lastKey.current === key) return
		lastKey.current = key
		armedUntil.current = performance.now() + 700
	}, [key])

	useEffect(() => {
		const node = content.current!
		const slot = node.parentElement!
		let measured = false
		const observer = new ResizeObserver(([entry]) => {
			const next = entry!.contentRect.width
			if (!next || !measured || reduced || performance.now() > armedUntil.current) {
				measured = next > 0
				width.jump(next || 'auto')
				delete slot.dataset.morphing
				return
			}
			slot.dataset.morphing = ''
			animate(width, next, {
				...spring.morph,
				onComplete: () => {
					delete slot.dataset.morphing
				},
			})
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [content, reduced, width])

	return width
}

// Base UI keeps disabled menu items in the arrow-key order; Arc's Radix menu skips them, looping at the ends.
function moveToEnabledItem(event: BaseUIEvent<KeyboardEvent<HTMLDivElement>>) {
	const enabled = Array.from(
		event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])'),
	)
	const index = enabled.findIndex(item => item === document.activeElement)
	const last = enabled.length - 1
	let target = -1
	if (event.key === 'ArrowDown') target = index === last ? 0 : index + 1
	if (event.key === 'ArrowUp') target = index <= 0 ? last : index - 1
	if (event.key === 'Home') target = 0
	if (event.key === 'End') target = last
	if (target < 0 || target > last) return
	event.preventBaseUIHandler()
	event.preventDefault()
	enabled[target]!.focus()
}

// Names the icon element, so swapping Link for Check morphs while a re-render of the same icon stays still.
// Tabler icons are forwardRef objects, so only their displayName tells them apart.
function iconKey(icon: ReactNode) {
	if (!isValidElement(icon)) return icon == null || typeof icon === 'boolean' ? '' : String(icon)
	const type = icon.type
	if (typeof type === 'string') return type
	const name = 'displayName' in type ? type.displayName : type.name
	return typeof name === 'string' ? name : 'icon'
}

function segmentsIn(group: HTMLElement) {
	return Array.from(group.querySelectorAll<HTMLElement>(':scope > [data-key]'))
}

function segmentIn(group: HTMLElement, key: string | null) {
	return segmentsIn(group).find(node => node.dataset.key === key)
}

function isInert(node: HTMLElement) {
	return node.matches(":disabled, [aria-disabled='true']")
}

// The segment's box inside the group at sub-pixel precision, undoing any scale an ancestor applies.
function boxOf(group: HTMLElement, node: HTMLElement) {
	const outer = group.getBoundingClientRect()
	const inner = node.getBoundingClientRect()
	// offsetWidth is rounded to whole pixels, so only a real transform (more than a pixel apart) counts as scale.
	const scale =
		group.offsetWidth && Math.abs(outer.width - group.offsetWidth) > 1 ? outer.width / group.offsetWidth : 1
	return [
		(inner.left - outer.left) / scale - group.clientLeft + group.scrollLeft,
		(inner.top - outer.top) / scale - group.clientTop + group.scrollTop,
		inner.width / scale,
		inner.height / scale,
	]
}
