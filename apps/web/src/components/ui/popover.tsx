import { type ComponentProps, createContext, type KeyboardEvent, type RefObject, use, useRef } from 'react'
import { Popover as BasePopover } from '@base-ui/react/popover'
import { cn } from 'cn'

const ClosedByOutsidePressContext = createContext<RefObject<boolean>>({ current: false })

export function Popover({ onOpenChange, ...props }: ComponentProps<typeof BasePopover.Root>) {
	const closedByOutsidePress = useRef(false)

	return (
		<ClosedByOutsidePressContext value={closedByOutsidePress}>
			<BasePopover.Root
				{...props}
				onOpenChange={(open, eventDetails) => {
					closedByOutsidePress.current = eventDetails.reason === 'outside-press'
					onOpenChange?.(open, eventDetails)
				}}
			/>
		</ClosedByOutsidePressContext>
	)
}
export const PopoverTrigger = BasePopover.Trigger
export const PopoverClose = BasePopover.Close

type PopoverContentProps = ComponentProps<typeof BasePopover.Popup> &
	Pick<ComponentProps<typeof BasePopover.Positioner>, 'side' | 'align' | 'sideOffset' | 'collisionPadding'>

export function PopoverContent({
	side,
	align = 'start',
	sideOffset = 6,
	collisionPadding = 10,
	className,
	onKeyDown,
	...props
}: PopoverContentProps) {
	const closedByOutsidePress = use(ClosedByOutsidePressContext)

	return (
		<BasePopover.Portal>
			<BasePopover.Positioner
				side={side}
				align={align}
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				className='z-80'
			>
				<BasePopover.Popup
					// Base UI sets `transition: none` on the mount frame; the `starting:` entrance needs it live to move on that frame, as Arc's does.
					style={{ transition: undefined }}
					// Radix leaves focus where an outside press put it; Base UI would pull it back to the trigger.
					finalFocus={() => !closedByOutsidePress.current}
					{...props}
					onKeyDown={event => {
						loopTabFocus(event)
						onKeyDown?.(event)
					}}
					className={cn(
						'max-w-[min(22rem,var(--available-width))] min-w-48 origin-(--transform-origin) rounded-panel border bg-surface-raised p-4 text-foreground shadow-floating',
						'[transition:opacity_110ms_var(--ease-enter),scale_400ms_var(--ease-spring),translate_400ms_var(--ease-spring)]',
						'starting:opacity-0 motion-safe:starting:scale-97 motion-safe:starting:data-[side=bottom]:-translate-y-1.25 motion-safe:starting:data-[side=left]:translate-x-1.25 motion-safe:starting:data-[side=right]:-translate-x-1.25 motion-safe:starting:data-[side=top]:translate-y-1.25',
						'data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-110 data-ending-style:ease-standard motion-safe:data-ending-style:scale-98 motion-safe:data-ending-style:data-[side=bottom]:-translate-y-[2.5px] motion-safe:data-ending-style:data-[side=left]:translate-x-[2.5px] motion-safe:data-ending-style:data-[side=right]:-translate-x-[2.5px] motion-safe:data-ending-style:data-[side=top]:translate-y-[2.5px]',
						className,
					)}
				/>
			</BasePopover.Positioner>
		</BasePopover.Portal>
	)
}

// Radix's non-modal content loops Tab at its edges (FocusScope `loop`); Base UI would close on focus-out instead.
function loopTabFocus(event: KeyboardEvent<HTMLDivElement>) {
	if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
	const tabbables = [...event.currentTarget.querySelectorAll<HTMLElement>('*')].filter(
		element => element.tabIndex >= 0 && !element.matches(':disabled') && element.checkVisibility(),
	)
	const first = tabbables[0]
	const last = tabbables.at(-1)
	if (!first || !last) {
		if (document.activeElement === event.currentTarget) event.preventDefault()
		return
	}
	if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault()
		first.focus()
	} else if (event.shiftKey && document.activeElement === first) {
		event.preventDefault()
		last.focus()
	}
}
