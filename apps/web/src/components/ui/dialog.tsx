import { type ComponentProps, createContext, type CSSProperties, type ReactNode, useContext, useState } from 'react'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { IconX } from '@tabler/icons-react'
import { cn } from 'cn'
import { AnimatePresence, motion, type Transition, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

const { blur, duration, ease, spring } = motionTokens

// Mirrors the open state so the content can stay mounted while it animates out, and retarget mid-flight if it is reopened or closed early.
const OpenContext = createContext(false)

export function Dialog({
	open: openProp,
	defaultOpen = false,
	onOpenChange,
	...props
}: ComponentProps<typeof BaseDialog.Root>) {
	const [uncontrolled, setUncontrolled] = useState(defaultOpen)
	const open = openProp ?? uncontrolled

	function setOpen(next: boolean, eventDetails: BaseDialog.Root.ChangeEventDetails) {
		if (openProp === undefined) setUncontrolled(next)
		onOpenChange?.(next, eventDetails)
	}

	return (
		<OpenContext.Provider value={open}>
			<BaseDialog.Root {...props} open={open} onOpenChange={setOpen} />
		</OpenContext.Provider>
	)
}

export const DialogTrigger = BaseDialog.Trigger
export const DialogClose = BaseDialog.Close

type DialogContentProps = Omit<ComponentProps<typeof BaseDialog.Popup>, 'title' | 'children' | 'className'> & {
	title: string
	description?: string
	// vexdock: the Morph recipe's name (styles.css); the title carries over from the row that opened the dialog.
	morph?: string
	children: ReactNode
	className?: string
}

const fade: Transition = { duration: duration.instant }
const leave: Transition = { duration: duration.fast, ease: [...ease.standard] }

// The overlay fades while the dialog rises 8px and scales up on a spring. Closing is shorter and quieter, and starts from wherever the entrance is.
export function DialogContent({ title, description, morph, children, className, ...props }: DialogContentProps) {
	const open = useContext(OpenContext)
	const reduced = useReducedMotion()
	const morphTarget: (CSSProperties & Record<'--morph', string>) | undefined = morph
		? { '--morph': morph }
		: undefined

	return (
		<AnimatePresence>
			{open && (
				<BaseDialog.Portal key='dialog' keepMounted>
					<BaseDialog.Backdrop
						// vexdock: marks the backdrop for the Recede rule in styles.css, so the page steps back under it.
						data-scrim
						className='fixed inset-0 z-50 bg-background/46 backdrop-blur-[7px] data-closed:pointer-events-none'
						render={
							<motion.div
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0, transition: reduced ? fade : leave }}
								transition={reduced ? fade : { duration: duration.standard, ease: [...ease.enter] }}
							/>
						}
					/>
					<BaseDialog.Popup
						{...props}
						className={cn(
							// vexdock: --dialog-width lets a call site widen it (forms 32rem, log viewers 72rem); Arc pins 440px.
							'fixed inset-0 z-51 m-auto h-fit max-h-[calc(100dvh-2rem)] w-[min(100%-2rem,var(--dialog-width,440px))] overflow-auto rounded-surface border bg-surface-raised text-foreground shadow-floating data-closed:pointer-events-none',
							className,
						)}
						render={
							<motion.div
								// vexdock: a morphing dialog only fades, so its title is captured where it lands.
								initial={reduced || morph ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
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
												default: spring.smooth,
												opacity: { duration: duration.fast, ease: [...ease.enter] },
											}
								}
							/>
						}
					>
						<div className='flex items-start justify-between gap-3.5 border-b p-4'>
							<div>
								{/* vexdock: w-fit, so a morph lands on the title's own box, not the width of a longer description. */}
								<BaseDialog.Title
									data-morph={morph ? '' : undefined}
									style={morphTarget}
									className='relative m-0 w-fit text-lg font-medium wrap-anywhere'
								>
									<SwapText text={title} />
								</BaseDialog.Title>
								{description ? (
									<BaseDialog.Description className='relative mt-1.5 text-sm wrap-anywhere text-secondary'>
										<SwapText text={description} />
									</BaseDialog.Description>
								) : null}
							</div>
							{/* The negative margin centres the button on the title's first line. */}
							<BaseDialog.Close
								aria-label='Close dialog'
								className='-my-[calc((1.75rem-var(--text-lg)*var(--text-lg--line-height))/2)] grid size-7 flex-none place-items-center rounded-control border bg-surface-muted/50 text-secondary [transition:background-color_110ms_var(--ease-standard),color_110ms_var(--ease-standard),scale_400ms_var(--ease-spring)] hover:bg-surface-muted hover:text-foreground active:[transition-duration:110ms,110ms,85ms] active:ease-standard motion-safe:active:scale-96'
							>
								<IconX size={16} stroke={1.75} aria-hidden />
							</BaseDialog.Close>
						</div>
						<div className='p-4 text-sm'>{children}</div>
					</BaseDialog.Popup>
				</BaseDialog.Portal>
			)}
		</AnimatePresence>
	)
}

// When the title or description changes while open, the new copy rises in and the old copy leaves upward.
function SwapText({ text }: { text: string }) {
	const reduced = useReducedMotion()
	return (
		<AnimatePresence mode='popLayout' initial={false}>
			<motion.span
				key={text}
				className='block'
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
			>
				{text}
			</motion.span>
		</AnimatePresence>
	)
}
