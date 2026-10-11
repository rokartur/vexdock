import type { ComponentProps } from 'react'
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { cn } from 'cn'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverClose = PopoverPrimitive.Close

export function PopoverContent({
	className,
	align = 'start',
	side,
	sideOffset = 6,
	collisionPadding = 10,
	...props
}: Omit<ComponentProps<typeof PopoverPrimitive.Popup>, 'className'> &
	Pick<PopoverPrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset' | 'collisionPadding'> & {
		className?: string
	}) {
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
					className={cn(
						'max-w-[min(22rem,var(--available-width))] min-w-48 popup rounded-panel border bg-surface-raised p-3 text-foreground shadow-floating',
						className,
					)}
				/>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	)
}
