import { useRef } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { IconX } from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from './button'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

type DialogContentProps = Omit<ComponentProps<typeof DialogPrimitive.Popup>, 'title' | 'className' | 'render'> & {
	title: ReactNode
	description?: ReactNode
	children: ReactNode
	className?: string
}

export function DialogContent(props: DialogContentProps) {
	return (
		<DialogPrimitive.Portal>
			<DialogPrimitive.Backdrop className='fixed inset-0 z-50 bg-background/60 scrim data-closed:pointer-events-none supports-backdrop-filter:backdrop-blur-xs' />
			<DialogPopup {...props} />
		</DialogPrimitive.Portal>
	)
}

function DialogPopup({ title, description, children, className, ...props }: DialogContentProps) {
	// Base UI returns focus to what was focused before opening; a menu item that opened the dialog has unmounted with its
	// menu by then, so the open menu's trigger stands in. Kept from the render that mounts the popup, before focus moves in.
	const opener = useRef(openerOf(document.activeElement))
	return (
		<DialogPrimitive.Popup
			finalFocus={() => (opener.current?.isConnected ? opener.current : true)}
			{...props}
			className={cn(
				'fixed top-1/2 left-1/2 z-51 max-h-[calc(100dvh-2rem)] w-[min(calc(100%-2rem),var(--dialog-width,440px))] popup -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-surface border bg-surface text-foreground shadow-floating data-closed:pointer-events-none',
				className,
			)}
		>
			<div className='flex items-start justify-between gap-3 border-b border-border-subtle p-4'>
				<div className='min-w-0 flex-1'>
					<DialogPrimitive.Title className='text-base font-medium wrap-anywhere'>
						{title}
					</DialogPrimitive.Title>
					{description ? (
						<DialogPrimitive.Description className='mt-1 text-sm wrap-anywhere text-secondary'>
							{description}
						</DialogPrimitive.Description>
					) : null}
				</div>
				<DialogPrimitive.Close
					render={<Button variant='ghost' size='sm' icon aria-label='Close dialog' className='-my-0.5' />}
				>
					<IconX aria-hidden />
				</DialogPrimitive.Close>
			</div>
			<div className='p-4 text-sm'>{children}</div>
		</DialogPrimitive.Popup>
	)
}

function openerOf(active: Element | null) {
	if (!(active instanceof HTMLElement) || active === document.body) return null
	if (!active.closest('[role=menu]')) return active
	return document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]')
}
