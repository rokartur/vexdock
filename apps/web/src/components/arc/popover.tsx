'use client'

import type { ComponentPropsWithoutRef } from 'react'
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { cn } from '@/utils/cn'

export const Popover = PopoverPrimitive.Root
export const PopoverClose = PopoverPrimitive.Close

/** The trigger anchors the panel, so it opts out of press-scale: a scaled rect measured on open would shift the panel as the trigger springs back. */
export function PopoverTrigger({
	className,
	...props
}: Omit<ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>, 'className'> & { className?: string }) {
	return <PopoverPrimitive.Trigger {...props} className={cn('enabled:active:transform-none', className)} />
}

type PopoverContentProps = Omit<ComponentPropsWithoutRef<typeof PopoverPrimitive.Popup>, 'className'> &
	Pick<PopoverPrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset' | 'collisionPadding'> & {
		className?: string
	}

export function PopoverContent({
	className,
	align = 'start',
	side,
	sideOffset = 6,
	collisionPadding = 10,
	...props
}: PopoverContentProps) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Positioner
				className='z-80'
				align={align}
				side={side}
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
			>
				<PopoverPrimitive.Popup
					{...props}
					// The panel starts a few pixels toward its trigger and settles on a spring; it leaves faster than it arrives.
					// Transitions instead of keyframes, so a close that interrupts the open reverses from where the panel is.
					className={cn(
						'max-w-[min(22rem,calc(100vw-20px))] min-w-48 origin-(--transform-origin) rounded-(--radius-control) border border-border bg-(--surface-raised) p-2.5 text-foreground shadow-(--shadow-floating) [--popover-x:0px] [--popover-y:-5px] [transition:opacity_var(--duration-fast)_var(--ease-enter),transform_var(--duration-spring)_var(--ease-spring)] focus:outline-none data-[side=left]:[--popover-x:5px] data-[side=left]:[--popover-y:0px] data-[side=right]:[--popover-x:-5px] data-[side=right]:[--popover-y:0px] data-[side=top]:[--popover-y:5px]',
						'data-starting-style:[transform:translate(var(--popover-x),var(--popover-y))_scale(0.97)] data-starting-style:opacity-0',
						'data-ending-style:pointer-events-none data-ending-style:[transform:translate(calc(var(--popover-x)*0.5),calc(var(--popover-y)*0.5))_scale(0.98)] data-ending-style:opacity-0 data-ending-style:[transition:opacity_var(--duration-fast)_var(--ease-standard),transform_var(--duration-fast)_var(--ease-standard)]',
						'motion-reduce:[transform:none]! motion-reduce:[transition:opacity_var(--duration-instant)_var(--ease-standard)]!',
						className,
					)}
				/>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	)
}
