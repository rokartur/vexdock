'use client'

import { createContext, useContext, useState } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { IconX } from '@tabler/icons-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Transition } from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'

/** Mirrors the open state so AnimatePresence can keep the popup mounted while it animates out, and retarget mid-flight. */
const OpenContext = createContext(false)

export function Dialog({
	open: openProp,
	defaultOpen = false,
	onOpenChange,
	...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
	const [uncontrolled, setUncontrolled] = useState(defaultOpen)
	const open = openProp ?? uncontrolled
	return (
		<OpenContext value={open}>
			<DialogPrimitive.Root
				{...props}
				open={open}
				onOpenChange={(next, details) => {
					if (openProp === undefined) setUncontrolled(next)
					onOpenChange?.(next, details)
				}}
			/>
		</OpenContext>
	)
}

export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export interface DialogContentProps extends Omit<
	ComponentPropsWithoutRef<typeof DialogPrimitive.Popup>,
	'title' | 'className' | 'render'
> {
	/** A string swaps with motion when it changes; a node (a name with a status beside it) is drawn as is. */
	title: ReactNode
	description?: ReactNode
	children: ReactNode
	className?: string
}

const fade: Transition = { duration: motionTokens.duration.instant }
const leave: Transition = { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] }

function openerOf(active: Element | null) {
	if (!(active instanceof HTMLElement) || active === document.body) return null
	if (!active.closest('[role=menu]')) return active
	return document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]')
}

/** When the title or description changes while open, the new copy rises in and the old copy leaves upward. */
function SwapText({ text }: { text: ReactNode }) {
	const reduced = useReducedMotion()
	if (typeof text !== 'string') return text
	return (
		<AnimatePresence mode='popLayout' initial={false}>
			<motion.span
				key={text}
				// Line height sits on the text itself, so a heading reset cannot shrink the title and pull the close button off its line.
				className='block leading-(--leading-body)'
				initial={reduced ? false : { opacity: 0, y: '0.3em', filter: `blur(${motionTokens.blur.soft}px)` }}
				animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
				exit={
					reduced
						? { opacity: 0, transition: { duration: 0 } }
						: {
								opacity: 0,
								y: '-0.3em',
								filter: `blur(${motionTokens.blur.subtle}px)`,
								transition: {
									duration: motionTokens.duration.fast,
									ease: [...motionTokens.ease.standard],
								},
							}
				}
				transition={{ duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}
			>
				{text}
			</motion.span>
		</AnimatePresence>
	)
}

export function DialogContent({ title, description, children, className, ...props }: DialogContentProps) {
	const open = useContext(OpenContext)
	const reduced = useReducedMotion()
	// Base UI returns focus to the element focused before opening; a menu item that opened the dialog has unmounted with
	// its menu by then, so the open menu's trigger stands in. Read at the render that opens, before focus moves in.
	const [opener, setOpener] = useState<HTMLElement | null>(null)
	const [wasOpen, setWasOpen] = useState(open)
	if (open !== wasOpen) {
		setWasOpen(open)
		if (open) setOpener(openerOf(document.activeElement))
	}
	// The overlay fades while the dialog rises 8px and scales up on a spring. Closing is shorter and quieter, and starts from wherever the entrance is.
	// While the layers leave, clicks pass through, so the trigger can reopen the dialog mid-exit.
	return (
		<AnimatePresence>
			{open && (
				<DialogPrimitive.Portal key='dialog' keepMounted>
					<DialogPrimitive.Backdrop
						render={
							<motion.div
								className='fixed inset-0 z-50 bg-[oklch(10%_0_0/0.46)] backdrop-blur-[7px] data-closed:pointer-events-none!'
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0, transition: reduced ? fade : leave }}
								transition={
									reduced
										? fade
										: {
												duration: motionTokens.duration.standard,
												ease: [...motionTokens.ease.enter],
											}
								}
							/>
						}
					/>
					<DialogPrimitive.Popup
						finalFocus={() => (opener?.isConnected ? opener : true)}
						{...props}
						render={
							<motion.div
								initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
								animate={{ opacity: 1, y: 0, scale: 1 }}
								exit={
									reduced
										? { opacity: 0, transition: fade }
										: { opacity: 0, y: 4, scale: 0.98, transition: leave }
								}
								transition={
									reduced
										? fade
										: {
												default: motionTokens.spring.smooth,
												opacity: {
													duration: motionTokens.duration.fast,
													ease: [...motionTokens.ease.enter],
												},
											}
								}
							/>
						}
						// Centered with auto margins, like a native modal, so transform stays free for the entrance spring.
						className={cn(
							'fixed inset-0 z-51 m-auto h-fit max-h-[calc(100dvh-var(--space-8))] w-[min(calc(100vw-var(--space-8)),var(--dialog-width,440px))] overflow-auto rounded-(--radius-surface) border border-border bg-(--surface-raised) text-foreground shadow-(--shadow-floating) focus:outline-none data-closed:pointer-events-none!',
							className,
						)}
					>
						<div className='flex items-start justify-between gap-(--space-4) border-b border-border p-4'>
							<div className='min-w-0 flex-1'>
								<DialogPrimitive.Title className='relative m-0 font-(family-name:--font-body) text-base/(--leading-body) font-medium tracking-(--tracking-body) wrap-anywhere'>
									<SwapText text={title} />
								</DialogPrimitive.Title>
								{description ? (
									<DialogPrimitive.Description className='relative mt-(--space-2) text-sm/(--leading-body) wrap-anywhere text-(--text-secondary)'>
										<SwapText text={description} />
									</DialogPrimitive.Description>
								) : null}
							</div>
							{/* Quick press, spring release. The negative margin centres it on the title's first line. */}
							<DialogPrimitive.Close
								className='my-[calc((var(--text-base)*var(--leading-body)-var(--control-height-sm))/2)] grid size-(--control-height-sm) flex-none cursor-pointer place-items-center rounded-(--radius-control) border border-border bg-[color-mix(in_oklab,var(--surface-muted)_50%,transparent)] text-(--text-secondary) [transition:background-color_var(--duration-fast)_var(--ease-standard),color_var(--duration-fast)_var(--ease-standard),scale_var(--duration-spring)_var(--ease-spring)] hover:bg-(--surface-muted) hover:text-foreground active:scale-96 active:duration-(--duration-instant) active:ease-(--ease-standard) motion-reduce:transition-none motion-reduce:active:scale-100'
								aria-label='Close dialog'
							>
								<IconX size={16} stroke={1.75} aria-hidden='true' />
							</DialogPrimitive.Close>
						</div>
						<div className='p-4 text-sm/(--leading-body)'>{children}</div>
					</DialogPrimitive.Popup>
				</DialogPrimitive.Portal>
			)}
		</AnimatePresence>
	)
}
