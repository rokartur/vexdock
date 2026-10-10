'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import type { CSSProperties, FocusEvent, ReactElement, ReactNode } from 'react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { motion, useReducedMotion } from 'motion/react'
import { cn } from '@/utils/cn'
import { ArcLink } from './arc-provider'
import { motionTokens } from './motion-tokens'

export interface DropdownItem {
	label: string
	onSelect?: () => void
	/** Makes the item a link (through ArcProvider's router link). */
	href?: string
	disabled?: boolean
	icon?: ReactNode
	destructive?: boolean
	separatorBefore?: boolean
}
export interface DropdownMenuProps {
	items: DropdownItem[]
	/** Any button element (an icon button, a primary action) that opens the menu. */
	trigger: ReactElement
	side?: 'top' | 'bottom'
	align?: 'start' | 'end'
	/** Extra classes for the menu panel, such as a fixed width. */
	menuClassName?: string
}

type Highlight = { top: number; height: number; danger: boolean; glide: boolean }

export function DropdownMenu({ items, trigger, side = 'bottom', align = 'end', menuClassName }: DropdownMenuProps) {
	const reduced = useReducedMotion()
	const [highlight, setHighlight] = useState<Highlight | null>(null)
	const pointer = useRef(false)
	const clearTimer = useRef(0)
	useEffect(() => () => window.clearTimeout(clearTimer.current), [])
	// Base UI focuses the highlighted item (pointer or keyboard) and the popup when the pointer leaves an item.
	function onMenuFocus(event: FocusEvent<HTMLDivElement>) {
		const item = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="menuitem"]') : null
		window.clearTimeout(clearTimer.current)
		if (!item) {
			// A short grace period keeps the highlight gliding across separators and item gaps.
			clearTimer.current = window.setTimeout(() => setHighlight(null), pointer.current ? 70 : 0)
			return
		}
		const next = { top: item.offsetTop, height: item.offsetHeight, danger: item.dataset.tone === 'danger' }
		const glide = pointer.current
		setHighlight(current => ({ ...next, glide: glide && current !== null }))
	}
	return (
		<MenuPrimitive.Root
			onOpenChange={open => {
				if (open) {
					window.clearTimeout(clearTimer.current)
					setHighlight(null)
				}
			}}
		>
			<MenuPrimitive.Trigger render={trigger} />
			<MenuPrimitive.Portal>
				<MenuPrimitive.Positioner
					className='z-60'
					side={side}
					sideOffset={6}
					align={align}
					collisionPadding={12}
				>
					{/* The menu grows from the trigger edge. Transitions instead of keyframes, so a close that interrupts the open
					    (or a reopen during the close) reverses from where it is. Items rise in staggered by their --i. */}
					<MenuPrimitive.Popup
						className={cn(
							'group/menu relative max-w-(--available-width) min-w-[min(12rem,var(--available-width))] origin-(--transform-origin) rounded-(--radius-control) border border-border bg-(--surface-raised) p-1 shadow-(--shadow-floating) outline-none [--menu-x:0px] [--menu-y:-5px] [transition:opacity_var(--duration-fast)_var(--ease-enter),transform_var(--duration-spring)_var(--ease-spring)] data-[side=left]:[--menu-x:5px] data-[side=left]:[--menu-y:0px] data-[side=right]:[--menu-x:-5px] data-[side=right]:[--menu-y:0px] data-[side=top]:[--menu-y:5px]',
							'data-starting-style:[transform:translate(var(--menu-x),var(--menu-y))_scale(0.97)] data-starting-style:opacity-0',
							'data-ending-style:pointer-events-none data-ending-style:[transform:translate(calc(var(--menu-x)*0.5),calc(var(--menu-y)*0.5))_scale(0.985)] data-ending-style:opacity-0 data-ending-style:[transition:opacity_130ms_var(--ease-standard),transform_130ms_var(--ease-standard)]',
							'motion-reduce:[transform:none]! motion-reduce:[transition:opacity_var(--duration-instant)_linear]!',
							menuClassName,
						)}
						onFocus={onMenuFocus}
						onPointerMoveCapture={() => {
							pointer.current = true
						}}
						onKeyDownCapture={() => {
							pointer.current = false
						}}
					>
						{/* One highlight glides between items for the pointer and jumps instantly for the keyboard. */}
						<motion.span
							className={cn(
								'pointer-events-none absolute inset-x-1 top-0 rounded-(--radius-control) opacity-0 transition-colors duration-(--duration-fast) ease-(--ease-standard) motion-reduce:transition-none',
								highlight?.danger
									? 'bg-[color-mix(in_oklab,var(--danger)_8%,var(--surface))]'
									: 'bg-(--surface-muted)',
							)}
							aria-hidden='true'
							initial={false}
							animate={
								highlight ? { y: highlight.top, height: highlight.height, opacity: 1 } : { opacity: 0 }
							}
							transition={{
								default: highlight?.glide && !reduced ? motionTokens.spring.snappy : { duration: 0 },
								opacity: { duration: reduced ? 0 : 0.08 },
							}}
						/>
						{items.map((item, index) => {
							const body = (
								<>
									{item.icon && (
										// Tabler icons ship at 24px.
										<span
											className={cn(
												'inline-flex w-[17px] [&_svg]:size-4',
												item.destructive ? 'text-(--danger)' : 'text-(--text-secondary)',
											)}
											aria-hidden='true'
										>
											{item.icon}
										</span>
									)}
									{item.label}
								</>
							)
							const className = cn(
								'relative flex min-h-7 cursor-pointer items-center gap-1.5 rounded-(--radius-control) px-1.5 text-sm no-underline outline-none [transition:color_var(--duration-fast)_var(--ease-standard),opacity_var(--duration-standard)_var(--ease-enter)_calc(min(var(--i),4)*35ms),translate_var(--duration-standard)_var(--ease-enter)_calc(min(var(--i),4)*35ms)] focus-visible:outline-none data-disabled:cursor-default data-disabled:opacity-45 motion-reduce:transition-none',
								'group-data-starting-style/menu:translate-x-[calc(var(--menu-x)*0.4)] group-data-starting-style/menu:translate-y-[calc(var(--menu-y)*0.4)] group-data-starting-style/menu:opacity-0',
								item.destructive ? 'text-(--danger)' : 'text-foreground',
							)
							const shared = {
								className,
								'data-tone': item.destructive ? 'danger' : undefined,
								style: { '--i': index } as CSSProperties,
							}
							return (
								<Fragment key={item.label}>
									{item.separatorBefore && (
										<MenuPrimitive.Separator className='-mx-(--space-1) my-(--space-1) h-px bg-(--border-subtle)' />
									)}
									{item.href === undefined ? (
										<MenuPrimitive.Item
											{...shared}
											disabled={item.disabled}
											onClick={item.onSelect}
										>
											{body}
										</MenuPrimitive.Item>
									) : (
										<MenuPrimitive.LinkItem
											{...shared}
											closeOnClick
											render={<ArcLink href={item.href} />}
										>
											{body}
										</MenuPrimitive.LinkItem>
									)}
								</Fragment>
							)
						})}
					</MenuPrimitive.Popup>
				</MenuPrimitive.Positioner>
			</MenuPrimitive.Portal>
		</MenuPrimitive.Root>
	)
}

export default DropdownMenu
