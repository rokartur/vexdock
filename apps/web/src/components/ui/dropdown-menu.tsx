import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Menu } from '@base-ui/react/menu'
import { IconChevronDown } from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type DropdownItem = {
	label: string
	onSelect?: () => void
	// vexdock: makes the item a router link.
	href?: string
	disabled?: boolean
	icon?: ReactNode
	destructive?: boolean
	separatorBefore?: boolean
}

type DropdownMenuProps = {
	items: DropdownItem[]
	icon?: ReactNode
	// vexdock: the dashboard opens menus from its own buttons (a primary action, an icon button, the user row).
	// A trigger replaces Arc's labeled trigger; one of label or trigger is required.
	label?: string
	trigger?: ReactElement
	side?: 'top' | 'bottom'
	align?: 'start' | 'end'
	menuClassName?: string
}

type Highlight = { top: number; height: number; danger: boolean; glide: boolean }

const { blur, duration, ease, spring, stagger } = motionTokens

// Arc keeps the highlight 70ms after the pointer leaves an item, so it glides across separators and item gaps.
const pointerLeaveGraceMs = 70

export function DropdownMenu({
	label = '',
	items,
	icon,
	trigger,
	side = 'bottom',
	align = 'end',
	menuClassName,
}: DropdownMenuProps) {
	const reduced = useReducedMotion()
	const [highlight, setHighlight] = useState<Highlight | null>(null)
	const [held, setHeld] = useState(false)
	const clearTimer = useRef(0)
	useEffect(() => () => window.clearTimeout(clearTimer.current), [])

	function onOpenChange(open: boolean) {
		if (!open) return
		window.clearTimeout(clearTimer.current)
		setHighlight(null)
	}

	function onItemHighlighted(item: HTMLElement | undefined, { reason }: Menu.Root.HighlightEventDetails) {
		window.clearTimeout(clearTimer.current)
		if (!item) {
			clearTimer.current = window.setTimeout(
				() => setHighlight(null),
				reason === 'pointer' ? pointerLeaveGraceMs : 0,
			)
			return
		}
		const next = {
			top: item.offsetTop,
			height: item.offsetHeight,
			danger: item.dataset.tone === 'danger',
		}
		setHighlight(current => ({ ...next, glide: reason === 'pointer' && current !== null }))
	}

	return (
		<Menu.Root onOpenChange={onOpenChange} onItemHighlighted={onItemHighlighted}>
			{/* Base UI's modal backdrop clears :active once the menu opens on pointerdown, so the press color tracks the held pointer. */}
			{trigger ? (
				<Menu.Trigger render={trigger} />
			) : (
				<Menu.Trigger
					data-held={held || undefined}
					onPointerDown={event => {
						setHeld(true)
						const release = () => setHeld(false)
						const doc = event.currentTarget.ownerDocument
						doc.addEventListener('pointerup', release, { once: true })
						doc.addEventListener('pointercancel', release, { once: true })
					}}
					className='group/trigger inline-flex min-h-control-sm max-w-full items-center gap-1.5 rounded-control border bg-surface px-2.5 text-sm font-medium text-foreground [transition:background-color_85ms_var(--ease-standard),border-color_110ms_var(--ease-standard),box-shadow_110ms_var(--ease-standard)] hover:border-border-strong hover:bg-surface-muted hover:shadow-resting active:border-border-strong active:bg-[color-mix(in_oklab,var(--surface-muted),var(--border)_55%)] active:shadow-none data-held:bg-[color-mix(in_oklab,var(--surface-muted),var(--border)_55%)] data-popup-open:border-border-strong data-popup-open:shadow-none data-popup-open:not-data-held:bg-surface-muted'
				>
					{icon && (
						<span aria-hidden='true' className='inline-flex shrink-0 text-secondary'>
							{icon}
						</span>
					)}
					<TriggerLabel text={label} />
					<IconChevronDown
						aria-hidden='true'
						size={15}
						stroke={1.8}
						className='shrink-0 text-muted [transition:rotate_400ms_var(--ease-spring),color_110ms_var(--ease-standard)] group-data-popup-open/trigger:rotate-180'
					/>
				</Menu.Trigger>
			)}
			<Menu.Portal>
				<Menu.Positioner side={side} sideOffset={6} align={align} collisionPadding={12} className='z-60'>
					{/* Radix keeps Tab inside an open menu; Base UI would close it. */}
					<Menu.Popup
						onKeyDown={event => {
							if (event.key === 'Tab') event.preventDefault()
						}}
						className={cn(
							'relative max-w-(--available-width) min-w-[min(12rem,var(--available-width))] origin-(--transform-origin) rounded-panel border bg-surface-raised p-1 shadow-floating [--menu-x:0px] [--menu-y:-5px] [transition:opacity_110ms_var(--ease-enter),translate_400ms_var(--ease-spring),scale_400ms_var(--ease-spring)] data-ending-style:pointer-events-none data-ending-style:[translate:calc(var(--menu-x)*0.5)_calc(var(--menu-y)*0.5)] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-ending-style:[transition:opacity_85ms_var(--ease-standard),translate_85ms_var(--ease-standard),scale_85ms_var(--ease-standard)] data-starting-style:[translate:var(--menu-x)_var(--menu-y)] data-starting-style:scale-97 data-starting-style:opacity-0 data-[side=left]:[--menu-x:5px] data-[side=left]:[--menu-y:0px] data-[side=right]:[--menu-x:-5px] data-[side=right]:[--menu-y:0px] data-[side=top]:[--menu-y:5px]',
							menuClassName,
						)}
					>
						<motion.span
							aria-hidden='true'
							data-tone={highlight?.danger ? 'danger' : undefined}
							initial={false}
							animate={
								highlight ? { y: highlight.top, height: highlight.height, opacity: 1 } : { opacity: 0 }
							}
							transition={{
								default: highlight?.glide && !reduced ? spring.snappy : { duration: 0 },
								opacity: { duration: reduced ? 0 : duration.instant },
							}}
							className='pointer-events-none absolute inset-x-1 top-0 rounded-[calc(var(--radius-panel)-6px)] bg-surface-muted opacity-0 transition-[background-color] data-[tone=danger]:bg-[color-mix(in_oklab,var(--danger)_8%,var(--surface))]'
						/>
						{items.map((item, index) => (
							<Fragment key={item.label}>
								{item.separatorBefore && (
									<Menu.Separator className='-mx-1 my-1 h-px bg-border-subtle' />
								)}
								<Menu.Item
									data-tone={item.destructive ? 'danger' : undefined}
									disabled={item.disabled}
									onClick={item.onSelect}
									render={item.href === undefined ? undefined : <Link to={item.href} />}
									style={{
										transitionDelay: `0s, ${Math.min(index, 4) * stagger.item}s, ${Math.min(index, 4) * stagger.item}s`,
									}}
									className='relative flex min-h-control-md items-center gap-2.5 rounded-[calc(var(--radius-panel)-6px)] px-2.5 text-sm text-foreground [transition:color_110ms_var(--ease-standard),opacity_170ms_var(--ease-enter),translate_170ms_var(--ease-enter)] in-data-starting-style:[translate:calc(var(--menu-x)*0.4)_calc(var(--menu-y)*0.4)] in-data-starting-style:opacity-0 data-disabled:opacity-45 data-[tone=danger]:text-danger'
								>
									{item.icon && (
										<span
											aria-hidden='true'
											className='inline-flex w-4 text-secondary in-data-[tone=danger]:text-danger'
										>
											{item.icon}
										</span>
									)}
									{item.label}
								</Menu.Item>
							</Fragment>
						))}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}

// A new label rises in while the old one leaves, and the trigger width springs to the measured text instead of snapping.
function TriggerLabel({ text }: { text: string }) {
	const reduced = useReducedMotion()
	const measure = useRef<HTMLSpanElement>(null)
	const measured = useRef<string | null>(null)
	const [size, setSize] = useState<{ width: number | 'auto'; animate: boolean }>({
		width: 'auto',
		animate: false,
	})
	useLayoutEffect(() => {
		const node = measure.current
		if (!node) return
		const observer = new ResizeObserver(([entry]) => {
			const current = node.textContent
			// Only a text change morphs; the first measure and font swaps settle instantly.
			const animate = measured.current !== null && measured.current !== current
			measured.current = current
			setSize({ width: Math.ceil(entry!.borderBoxSize[0]!.inlineSize), animate })
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [])

	return (
		<motion.span
			initial={false}
			animate={{ width: size.width }}
			transition={size.animate && !reduced ? spring.morph : { duration: 0 }}
			className='relative inline-flex min-w-0 flex-[0_1_auto] overflow-x-clip'
		>
			<span
				ref={measure}
				aria-hidden='true'
				className='pointer-events-none invisible absolute top-0 left-0 whitespace-nowrap'
			>
				{text}
			</span>
			<AnimatePresence mode='popLayout' initial={false}>
				<motion.span
					key={text}
					initial={reduced ? false : { opacity: 0, y: '0.3em', filter: `blur(${blur.soft}px)` }}
					animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
					exit={
						reduced
							? { opacity: 0, transition: { duration: 0 } }
							: {
									opacity: 0,
									y: '-0.3em',
									filter: `blur(${blur.subtle}px)`,
									transition: { duration: duration.fast, ease: [...ease.standard] },
								}
					}
					transition={{ duration: duration.standard, ease: [...ease.enter] }}
					className='block min-w-0 truncate'
				>
					{text}
				</motion.span>
			</AnimatePresence>
		</motion.span>
	)
}
