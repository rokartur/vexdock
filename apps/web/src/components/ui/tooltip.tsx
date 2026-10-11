import type { ReactElement, ReactNode } from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'

/** One for the app (in __root.tsx): within `timeout` after a tooltip closes, the next opens with `data-instant`. */
export function TooltipProvider({ children }: { children: ReactNode }) {
	return (
		<TooltipPrimitive.Provider delay={250} timeout={300}>
			{children}
		</TooltipPrimitive.Provider>
	)
}

export function Tooltip({
	content,
	children,
	side = 'top',
}: {
	content: ReactNode
	children: ReactElement
	side?: 'top' | 'bottom' | 'left' | 'right'
}) {
	return (
		<TooltipPrimitive.Root>
			{/* render: the child is the control (a button, a link); a Trigger <button> around it would nest buttons. */}
			<TooltipPrimitive.Trigger render={children} />
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Positioner className='z-90' side={side} sideOffset={8} collisionPadding={12}>
					<TooltipPrimitive.Popup className='max-w-60 popup rounded-control bg-foreground px-2.5 py-1.5 text-xs text-background duration-160'>
						{content}
					</TooltipPrimitive.Popup>
				</TooltipPrimitive.Positioner>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	)
}
