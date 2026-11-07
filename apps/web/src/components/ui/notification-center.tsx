import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import {
	IconAlertTriangle,
	IconBell,
	IconCheck,
	IconChecks,
	IconCircleCheck,
	IconCircleDot,
	IconCircleX,
	IconMessageCircle,
	IconX,
} from '@tabler/icons-react'
import { cn } from 'cn'
import {
	type AnimationPlaybackControls,
	AnimatePresence,
	animate,
	type HTMLMotionProps,
	motion,
	type TargetAndTransition,
	type Transition,
	useIsPresent,
	useMotionValue,
	useReducedMotion,
	type Variants,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'
import { Avatar } from './avatar'

export interface NotificationItem {
	id: string
	title: string
	description?: string
	time: string
	// vexdock: the machine-readable stamp behind `time`, which is display text such as "3m ago".
	dateTime?: string
	read?: boolean
	tone?: 'info' | 'success' | 'warning' | 'danger'
	actor?: { name: string; photo: string }
}

export interface NotificationCenterProps {
	notifications: NotificationItem[]
	label?: string
	onReadChange?: (notification: NotificationItem, read: boolean) => void
	onDismiss?: (notification: NotificationItem) => void
	open?: boolean
	onOpenChange?: (open: boolean) => void
	avoidCollisions?: boolean
	// vexdock: replaces the all-clear text while the list is not known, such as a failed read, with a way out.
	empty?: { title: string; description: string; action?: ReactNode }
}

type View = 'all' | 'unread'

const { blur, duration, ease, spring, stagger } = motionTokens
const enter: Transition = { duration: duration.standard, ease: [...ease.enter] }
const exitFast: Transition = { duration: duration.fast, ease: [...ease.standard] }
const instant: Transition = { duration: 0 }
const textIn: TargetAndTransition = { opacity: 0, y: '0.3em', filter: `blur(${blur.soft}px)` }
const textOut: TargetAndTransition = {
	opacity: 0,
	y: '-0.3em',
	filter: `blur(${blur.subtle}px)`,
	transition: exitFast,
}
const iconIn: TargetAndTransition = { opacity: 0, scale: 0.6, filter: `blur(${blur.subtle}px)` }
const shown: TargetAndTransition = { opacity: 1, y: '0em', scale: 1, filter: 'blur(0px)' }
const fadeOut: TargetAndTransition = { opacity: 0, transition: { duration: duration.instant } }
const collapse: TargetAndTransition = {
	height: 0,
	opacity: 0,
	transition: { height: spring.smooth, opacity: exitFast },
}
// Bulk actions cascade down the list, capped so the whole sweep stays under a quarter second (Arc's 200ms at 0.7x).
const cascade = (index: number) => Math.min(index * stagger.item, 0.14)

const toneClass = {
	info: 'text-accent',
	success: 'text-success',
	warning: 'text-warning',
	// vexdock: a failed deploy outranks a cancelled one.
	danger: 'text-danger',
}

// vexdock: a map in place of Arc's ternary, which had no branch for `danger`.
const toneIcon = {
	info: IconMessageCircle,
	success: IconCircleCheck,
	warning: IconAlertTriangle,
	danger: IconCircleX,
}

// Outgoing copies are hidden from assistive tech while they fade, so live text reads only the current value.
function Swap(props: HTMLMotionProps<'span'>) {
	const present = useIsPresent()
	return <motion.span {...props} aria-hidden={present ? props['aria-hidden'] : true} />
}

function SwapText({ children, reduce }: { children: string; reduce: boolean }) {
	return (
		<span className='relative inline-block max-w-full align-top'>
			<AnimatePresence mode='popLayout' initial={false}>
				<Swap
					key={children}
					className='block'
					initial={reduce ? { opacity: 0 } : textIn}
					animate={shown}
					exit={reduce ? fadeOut : textOut}
					transition={reduce ? instant : enter}
				>
					{children}
				</Swap>
			</AnimatePresence>
		</span>
	)
}

const rollVariants: Variants = {
	enter: (direction: number) => ({
		opacity: 0,
		y: direction >= 0 ? '0.7em' : '-0.7em',
		filter: `blur(${blur.subtle}px)`,
	}),
	center: { opacity: 1, y: '0em', filter: 'blur(0px)' },
	exit: (direction: number) => ({
		opacity: 0,
		y: direction >= 0 ? '-0.7em' : '0.7em',
		filter: `blur(${blur.subtle}px)`,
		transition: exitFast,
	}),
}

// Counts roll like an odometer: a higher number rises from below, a lower one drops from above.
function RollingCount({
	value,
	display = String(value),
	reduce,
}: {
	value: number
	display?: string
	reduce: boolean
}) {
	const [previous, setPrevious] = useState(value)
	const [direction, setDirection] = useState(0)
	if (value !== previous) {
		setDirection(value > previous ? 1 : -1)
		setPrevious(value)
	}
	return (
		<span className='relative inline-grid align-top'>
			<AnimatePresence mode='popLayout' initial={false} custom={direction}>
				<Swap
					key={display}
					className='block'
					custom={direction}
					variants={reduce ? undefined : rollVariants}
					initial={reduce ? { opacity: 0 } : 'enter'}
					animate={reduce ? { opacity: 1 } : 'center'}
					exit={reduce ? fadeOut : 'exit'}
					transition={reduce ? instant : { y: spring.snappy, opacity: exitFast, filter: exitFast }}
				>
					{display}
				</Swap>
			</AnimatePresence>
		</span>
	)
}

// After `morphKey` changes the width springs from the old size to the new one, then returns to auto,
// so a longer label grows the control instead of snapping it.
function MorphWidth({ reduce, morphKey, children }: { reduce: boolean; morphKey: string; children: ReactNode }) {
	const frame = useRef<HTMLSpanElement>(null)
	const content = useRef<HTMLSpanElement>(null)
	const width = useMotionValue<number | 'auto'>('auto')
	const changedAt = useRef(0)
	useLayoutEffect(() => {
		changedAt.current = performance.now()
	}, [morphKey])
	useEffect(() => {
		const node = content.current
		if (!node) return
		let last: number | undefined
		let controls: AnimationPlaybackControls | undefined
		const settle = () => {
			width.jump('auto')
			if (frame.current) frame.current.style.width = 'auto'
		}
		const observer = new ResizeObserver(([entry]) => {
			const next = entry!.borderBoxSize[0]!.inlineSize
			const current = width.get()
			const from = typeof current === 'number' ? current : last
			last = next
			controls?.stop()
			// Only a resize within 120ms of the label swap morphs; anything later (a font load, a panel resize) snaps.
			if (reduce || from === undefined || from === next || performance.now() - changedAt.current > 120) {
				settle()
				return
			}
			// Pin the old width before this frame paints, then spring to the new one.
			if (frame.current) frame.current.style.width = `${from}px`
			controls = animate(width, [from, next], { ...spring.morph, onComplete: settle })
		})
		observer.observe(node)
		return () => {
			observer.disconnect()
			controls?.stop()
		}
	}, [width, reduce])
	return (
		<motion.span ref={frame} className='inline-flex items-center' style={{ width }}>
			<span ref={content} className='relative inline-flex w-max items-center gap-[5px]'>
				{children}
			</span>
		</motion.span>
	)
}

function NotificationVisual({ item }: { item: NotificationItem }) {
	if (item.actor) return <Avatar name={item.actor.name} src={item.actor.photo} size='md' />
	const tone = item.tone ?? 'info'
	const Icon = toneIcon[tone]
	return (
		<span className={cn('grid size-9 flex-none place-items-center', toneClass[tone])} aria-hidden='true'>
			<Icon size={18} stroke={1.7} />
		</span>
	)
}

export function NotificationCenter({
	notifications: initial,
	label = 'Notifications',
	onReadChange,
	onDismiss,
	open,
	onOpenChange,
	avoidCollisions = true,
	empty,
}: NotificationCenterProps) {
	const reduce = useReducedMotion() ?? false
	const layoutId = useId()
	const [internalOpen, setInternalOpen] = useState(false)
	const [items, setItems] = useState(initial)
	// vexdock: a live feed; new props replace the list, so the caller keeps read and dismissed state.
	const [received, setReceived] = useState(initial)
	if (received !== initial) {
		setReceived(initial)
		setItems(initial)
	}
	const [view, setView] = useState<View>('all')
	const [expandedId, setExpandedId] = useState<string | null>(null)
	const [bulk, setBulk] = useState(false)
	const itemRefs = useRef(new Map<string, HTMLButtonElement>())
	const allTabRef = useRef<HTMLButtonElement>(null)
	const unreadTabRef = useRef<HTMLButtonElement>(null)
	const isOpen = open ?? internalOpen
	const unreadCount = useMemo(() => items.filter(item => !item.read).length, [items])
	const readCount = items.length - unreadCount
	const visible = view === 'unread' ? items.filter(item => !item.read) : items
	// vexdock: while `empty` stands in for an unknown list, nothing claims the list is read.
	let summary = unreadCount
		? `${unreadCount} update${unreadCount === 1 ? '' : 's'} waiting for you`
		: 'You’re all caught up'
	if (empty) summary = empty.title

	function setOpen(next: boolean) {
		if (open === undefined) setInternalOpen(next)
		onOpenChange?.(next)
	}

	function focusNeighbour(item: NotificationItem) {
		const index = visible.findIndex(entry => entry.id === item.id)
		const nextId = visible[index + 1]?.id ?? visible[index - 1]?.id
		requestAnimationFrame(() => (nextId ? itemRefs.current.get(nextId)?.focus() : unreadTabRef.current?.focus()))
	}

	function toggleRead(item: NotificationItem) {
		const next = !item.read
		if (next && view === 'unread') focusNeighbour(item)
		setBulk(false)
		setItems(current => current.map(entry => (entry.id === item.id ? { ...entry, read: next } : entry)))
		if (next && view === 'unread') setExpandedId(null)
		onReadChange?.(item, next)
	}

	function markAllRead() {
		for (const item of items) if (!item.read) onReadChange?.(item, true)
		setBulk(true)
		setItems(current => current.map(item => ({ ...item, read: true })))
		setExpandedId(null)
		requestAnimationFrame(() => (view === 'unread' ? unreadTabRef : allTabRef).current?.focus())
	}

	function dismiss(item: NotificationItem) {
		focusNeighbour(item)
		setBulk(false)
		setItems(current => current.filter(entry => entry.id !== item.id))
		if (expandedId === item.id) setExpandedId(null)
		onDismiss?.(item)
	}

	function clearRead() {
		for (const item of items) if (item.read) onDismiss?.(item)
		setBulk(true)
		setItems(current => current.filter(item => !item.read))
		requestAnimationFrame(() => allTabRef.current?.focus())
	}

	const height: Transition = reduce ? instant : { height: spring.smooth, opacity: enter }

	return (
		<Popover.Root open={isOpen} onOpenChange={setOpen}>
			{/* The trigger anchors the panel, so it gives press feedback with color only; scaling it would shift the panel. */}
			{/* vexdock: a ghost trigger, the size and look of the header's other icon buttons; its badge rings in `background`, the header's own fill */}
			<Popover.Trigger
				className='relative grid size-control-md place-items-center rounded-control text-secondary transition-colors duration-110 ease-standard hover:bg-surface-muted hover:text-foreground active:bg-surface-pressed active:text-foreground data-popup-open:bg-surface-muted data-popup-open:text-foreground motion-reduce:transition-none'
				aria-label={`${label}${unreadCount ? `, ${unreadCount} unread` : ''}`}
			>
				<motion.span
					className='grid place-items-center'
					animate={{ rotate: isOpen && !reduce ? -12 : 0 }}
					transition={reduce ? instant : spring.snappy}
				>
					<IconBell size={16} stroke={1.75} aria-hidden='true' />
				</motion.span>
				<AnimatePresence initial={false}>
					{unreadCount > 0 && (
						<motion.span
							key='badge'
							className='absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center overflow-hidden rounded-full border-2 border-background bg-foreground px-[5px] text-xs leading-none font-medium text-background tabular-nums'
							aria-hidden='true'
							initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
							animate={{ opacity: 1, scale: 1 }}
							exit={reduce ? fadeOut : { opacity: 0, scale: 0.6, transition: exitFast }}
							transition={reduce ? instant : spring.snappy}
						>
							<RollingCount
								value={unreadCount}
								display={unreadCount > 9 ? '9+' : String(unreadCount)}
								reduce={reduce}
							/>
						</motion.span>
					)}
				</AnimatePresence>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner
					className='z-90'
					side='bottom'
					align='center'
					sideOffset={12}
					collisionPadding={12}
					collisionAvoidance={
						avoidCollisions ? undefined : { side: 'none', align: 'none', fallbackAxisSide: 'none' }
					}
				>
					{/* The panel grows out of the bell from a few pixels toward the trigger, and leaves faster than it arrives. */}
					<Popover.Popup
						aria-label={label}
						className={cn(
							'flex max-h-[min(590px,calc(100dvh-24px))] w-[min(424px,calc(100dvw-24px))] origin-(--transform-origin) flex-col overflow-hidden rounded-panel border bg-surface-raised text-foreground shadow-floating',
							'transition-[opacity,scale,translate] duration-170 ease-enter data-starting-style:scale-97 data-starting-style:opacity-0 data-[side=bottom]:data-starting-style:-translate-y-1.5 data-[side=left]:data-starting-style:translate-x-1.5 data-[side=right]:data-starting-style:-translate-x-1.5 data-[side=top]:data-starting-style:translate-y-1.5',
							'data-ending-style:scale-98 data-ending-style:opacity-0 data-ending-style:duration-85 data-ending-style:ease-standard data-[side=bottom]:data-ending-style:-translate-y-[3px] data-[side=left]:data-ending-style:translate-x-[3px] data-[side=right]:data-ending-style:-translate-x-[3px] data-[side=top]:data-ending-style:translate-y-[3px]',
						)}
					>
						<div className='flex items-start justify-between gap-3 px-6 pt-[23px] pb-[18px] max-[380px]:px-4 max-[380px]:pt-5 max-[380px]:pb-4'>
							<div>
								<div className='flex items-center gap-1.5'>
									<h2 className='m-0 text-xl/[1.2] font-medium max-[380px]:text-lg/[1.2]'>{label}</h2>
									{empty ? null : (
										<span className='grid h-[21px] min-w-[21px] place-items-center overflow-hidden rounded-[7px] bg-surface-muted px-[5px] text-xs leading-none text-secondary tabular-nums'>
											<RollingCount value={unreadCount} reduce={reduce} />
										</span>
									)}
								</div>
								<p className='relative mt-1 text-xs text-secondary' aria-live='polite'>
									<SwapText reduce={reduce}>{summary}</SwapText>
								</p>
							</div>
							<Popover.Close
								className='grid size-[30px] flex-none place-items-center rounded-[8px] text-muted [transition:scale_400ms_var(--ease-spring),color_110ms_var(--ease-standard),background-color_110ms_var(--ease-standard)] hover:bg-surface-muted hover:text-foreground active:duration-85 active:ease-standard motion-safe:active:scale-96'
								aria-label='Close notifications'
							>
								<IconX size={17} stroke={1.75} aria-hidden='true' />
							</Popover.Close>
						</div>

						<div className='flex min-h-[52px] items-center justify-between gap-3 border-b border-border-subtle pr-[17px] pb-[13px] pl-5 max-[380px]:items-start max-[380px]:px-3 max-[380px]:pb-3'>
							<div
								className='inline-flex items-center gap-[3px]'
								role='group'
								aria-label='Show notifications'
							>
								{(['all', 'unread'] as const).map(next => (
									<button
										key={next}
										ref={next === 'unread' ? unreadTabRef : allTabRef}
										type='button'
										className={cn(
											'relative isolate h-[31px] min-w-[61px] rounded-[9px] px-2.5 text-xs text-secondary hover:text-foreground',
											view === next && 'text-foreground',
										)}
										aria-pressed={view === next}
										onClick={() => {
											setBulk(false)
											setView(next)
											setExpandedId(null)
										}}
									>
										{view === next && (
											<motion.span
												className='absolute inset-0 -z-1 rounded-[9px] bg-surface-muted'
												layoutId={`${layoutId}-view`}
												transition={reduce ? instant : spring.morph}
											/>
										)}
										<span className='relative z-1'>{next === 'all' ? 'All' : 'Unread'}</span>
									</button>
								))}
							</div>
							<AnimatePresence initial={false}>
								{unreadCount > 0 && (
									<motion.button
										key='mark-all'
										type='button'
										className='inline-flex press items-center gap-1.5 py-1.5 text-xs whitespace-nowrap text-secondary hover:text-foreground'
										onClick={markAllRead}
										initial={
											reduce ? { opacity: 0 } : { opacity: 0, filter: `blur(${blur.subtle}px)` }
										}
										animate={{ opacity: 1, filter: 'blur(0px)' }}
										exit={
											reduce
												? fadeOut
												: { opacity: 0, filter: `blur(${blur.subtle}px)`, transition: exitFast }
										}
										transition={reduce ? instant : enter}
									>
										<IconChecks size={15} stroke={1.75} aria-hidden='true' />
										<span className='max-[380px]:sr-only'>Mark all read</span>
									</motion.button>
								)}
							</AnimatePresence>
						</div>

						{/* Rows collapse their own height on the way out, so the list and the panel close the gap together. */}
						<div
							className='min-h-0 [scrollbar-width:none] overflow-y-auto overscroll-contain px-[11px] pt-[9px] pb-2.5 max-[380px]:px-[5px] max-[380px]:py-2 [&::-webkit-scrollbar]:hidden'
							role='list'
							aria-label={view === 'all' ? 'All notifications' : 'Unread notifications'}
						>
							<AnimatePresence initial={false} custom={bulk}>
								{visible.map((item, index) => {
									const expanded = expandedId === item.id
									const rowStyle: CSSProperties & Record<`--${string}`, number> = {
										'--index': Math.min(index, 7),
									}
									return (
										<motion.div
											key={item.id}
											role='listitem'
											className='overflow-hidden'
											custom={bulk}
											variants={{
												exit: (isBulk: boolean) =>
													reduce
														? fadeOut
														: {
																height: 0,
																opacity: 0,
																transition: {
																	height: {
																		...spring.smooth,
																		delay: isBulk ? cascade(index) : 0,
																	},
																	opacity: {
																		...exitFast,
																		delay: isBulk ? cascade(index) : 0,
																	},
																},
															},
											}}
											initial={reduce ? { opacity: 0 } : { height: 0 }}
											animate={{ height: 'auto', opacity: 1 }}
											exit='exit'
											transition={height}
										>
											{/* Rows settle in with a short cascade when the panel opens or a view adds them. */}
											<article
												className={cn(
													'relative rounded-[calc(var(--radius-panel)-6px)] p-2.5 hover:bg-surface-muted max-[380px]:px-[7px]',
													'[transition:opacity_170ms_var(--ease-enter)_calc(var(--index)*25ms),translate_170ms_var(--ease-enter)_calc(var(--index)*25ms),background-color_110ms_var(--ease-standard)] starting:translate-y-1 starting:opacity-0',
													expanded && 'bg-surface-muted',
												)}
												style={rowStyle}
											>
												<div className='flex min-w-0 items-start gap-[11px] max-[380px]:gap-[7px]'>
													<NotificationVisual item={item} />
													<button
														ref={node => {
															if (node) itemRefs.current.set(item.id, node)
															else itemRefs.current.delete(item.id)
														}}
														type='button'
														className='grid min-w-0 flex-1 gap-1 pt-0.5 text-left text-foreground'
														aria-expanded={expanded}
														aria-label={`${item.title}${item.read ? '' : ', unread'}. ${expanded ? 'Hide details' : 'Show details'}`}
														onClick={() =>
															setExpandedId(current =>
																current === item.id ? null : item.id,
															)
														}
													>
														<span className='flex min-h-5 min-w-0 items-center gap-1.5'>
															<strong
																className={cn(
																	'truncate text-sm font-medium',
																	item.read && 'text-secondary',
																)}
															>
																{item.title}
															</strong>
															<AnimatePresence initial={false} custom={bulk}>
																{!item.read && (
																	<motion.span
																		key='dot'
																		className='block size-1.5 flex-none rounded-full bg-foreground'
																		aria-hidden='true'
																		custom={bulk}
																		variants={{
																			exit: (isBulk: boolean) =>
																				reduce
																					? fadeOut
																					: {
																							opacity: 0,
																							scale: 0.3,
																							transition: {
																								...exitFast,
																								delay: isBulk
																									? cascade(index)
																									: 0,
																							},
																						},
																		}}
																		initial={
																			reduce
																				? { opacity: 0 }
																				: { opacity: 0, scale: 0.3 }
																		}
																		animate={{ opacity: 1, scale: 1 }}
																		exit='exit'
																		transition={reduce ? instant : spring.snappy}
																	/>
																)}
															</AnimatePresence>
														</span>
														<span className='truncate text-xs text-secondary'>
															{item.description ??
																(item.actor
																	? `From ${item.actor.name}`
																	: 'View update details')}
														</span>
													</button>
													<time
														dateTime={item.dateTime}
														className='flex-none pt-1 text-xs whitespace-nowrap text-muted tabular-nums'
													>
														{item.time}
													</time>
												</div>
												<AnimatePresence initial={false}>
													{expanded && (
														<motion.div
															className='overflow-hidden pl-[47px] max-[380px]:pl-[43px]'
															initial={
																reduce ? { opacity: 0 } : { height: 0, opacity: 0 }
															}
															animate={{ height: 'auto', opacity: 1 }}
															exit={reduce ? fadeOut : collapse}
															transition={height}
														>
															<p className='my-3 text-xs text-secondary'>
																{item.description ??
																	(item.actor
																		? `${item.actor.name} shared an update with you.`
																		: 'This update is ready to review.')}
															</p>
															<div className='flex flex-wrap gap-1.5 pb-[5px] max-[380px]:gap-[5px]'>
																<button
																	type='button'
																	className={actionClass}
																	onClick={() => toggleRead(item)}
																>
																	<MorphWidth
																		reduce={reduce}
																		morphKey={item.read ? 'read' : 'unread'}
																	>
																		<span className='relative grid place-items-center'>
																			<AnimatePresence
																				mode='popLayout'
																				initial={false}
																			>
																				<Swap
																					key={item.read ? 'unread' : 'read'}
																					className='relative grid place-items-center'
																					initial={
																						reduce ? { opacity: 0 } : iconIn
																					}
																					animate={shown}
																					exit={
																						reduce
																							? fadeOut
																							: {
																									...iconIn,
																									transition:
																										exitFast,
																								}
																					}
																					transition={
																						reduce ? instant : spring.snappy
																					}
																				>
																					{item.read ? (
																						<IconCircleDot
																							size={14}
																							stroke={1.75}
																							aria-hidden='true'
																						/>
																					) : (
																						<IconCheck
																							size={14}
																							stroke={1.75}
																							aria-hidden='true'
																						/>
																					)}
																				</Swap>
																			</AnimatePresence>
																		</span>
																		<SwapText reduce={reduce}>
																			{item.read ? 'Mark unread' : 'Mark read'}
																		</SwapText>
																	</MorphWidth>
																</button>
																<button
																	type='button'
																	className={actionClass}
																	onClick={() => dismiss(item)}
																>
																	<IconX size={14} stroke={1.75} aria-hidden='true' />
																	Dismiss
																</button>
															</div>
														</motion.div>
													)}
												</AnimatePresence>
											</article>
										</motion.div>
									)
								})}
								{/* The empty state opens on the spring the rows close on, so the panel morphs between them; after a bulk action it waits for the cascade. */}
								{visible.length === 0 && (
									<motion.div
										key='empty'
										className='overflow-hidden'
										initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
										animate={{ height: 'auto', opacity: 1 }}
										exit={reduce ? fadeOut : collapse}
										transition={
											reduce
												? instant
												: {
														height: { ...spring.smooth, delay: bulk ? cascade(3) : 0 },
														opacity: { ...enter, delay: duration.fast },
													}
										}
									>
										<motion.div
											className='grid min-h-[190px] content-center justify-items-center px-3 py-[22px] text-center'
											initial={reduce ? false : { y: 6 }}
											animate={{ y: 0 }}
											transition={reduce ? instant : { ...enter, delay: duration.fast }}
										>
											{empty ? null : (
												<IconCircleCheck
													size={24}
													stroke={1.5}
													className='mb-[13px] text-muted'
													aria-hidden='true'
												/>
											)}
											<strong className='text-sm font-medium'>
												<SwapText reduce={reduce}>
													{empty?.title ??
														(view === 'unread' ? 'Nothing unread' : 'All clear')}
												</SwapText>
											</strong>
											<p className='mt-1 text-xs text-secondary'>
												<SwapText reduce={reduce}>
													{empty?.description ??
														(view === 'unread'
															? 'You’ve seen every update.'
															: 'New updates will appear here.')}
												</SwapText>
											</p>
											{empty?.action ? <div className='mt-4'>{empty.action}</div> : null}
											{view === 'unread' && items.length > 0 && (
												<button
													type='button'
													className='mt-4 text-xs text-foreground underline underline-offset-3'
													onClick={() => {
														setBulk(false)
														setView('all')
													}}
												>
													View all updates
												</button>
											)}
										</motion.div>
									</motion.div>
								)}
							</AnimatePresence>
						</div>

						<AnimatePresence initial={false}>
							{readCount > 0 && (
								<motion.div
									key='footer'
									className='flex-none overflow-hidden'
									initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
									animate={{ height: 'auto', opacity: 1 }}
									exit={reduce ? fadeOut : collapse}
									transition={height}
								>
									<div className='flex min-h-[46px] items-center justify-between gap-3 border-t border-border-subtle px-[22px] py-2 text-xs text-muted max-[380px]:px-4'>
										<span>
											<RollingCount value={readCount} reduce={reduce} /> read
										</span>
										<button
											type='button'
											className='press py-1 text-xs text-secondary hover:text-foreground'
											onClick={clearRead}
										>
											Clear read
										</button>
									</div>
								</motion.div>
							)}
						</AnimatePresence>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	)
}

const actionClass =
	'press inline-flex h-[30px] items-center gap-[5px] overflow-clip rounded-[10px] border border-border-strong/30 px-2.5 text-xs leading-none whitespace-nowrap text-foreground hover:border-border-strong hover:bg-surface-muted max-[380px]:px-[7px]'
