import { useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import { cn } from 'cn'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

type PasswordFieldMessages = { showPassword: string; hidePassword: string }

const defaultMessages: PasswordFieldMessages = {
	showPassword: 'Show password',
	hidePassword: 'Hide password',
}

type PasswordFieldProps = Omit<ComponentProps<'input'>, 'type'> & {
	label: string
	description?: string
	messages?: Partial<PasswordFieldMessages>
	// vexdock: keeps the label for assistive tech only, for a control in a table row or a toolbar.
	hideLabel?: boolean
}

// Two names, so swapping data-reveal between them restarts the resolve on every toggle.
const revealKeyframes =
	'@keyframes password-reveal-shown{from{opacity:.35;filter:blur(2px)}}@keyframes password-reveal-hidden{from{opacity:.35;filter:blur(2px)}}'

export function PasswordField({
	label,
	description,
	messages: messagesProp,
	hideLabel,
	id,
	className,
	...props
}: PasswordFieldProps) {
	const messages = { ...defaultMessages, ...messagesProp }
	const generatedId = useId()
	const controlId = id ?? generatedId
	const [visible, setVisible] = useState(false)
	const [toggled, setToggled] = useState(false)
	const hintId = description ? `${controlId}-description` : undefined
	const describedBy = [props['aria-describedby'], hintId].filter(Boolean).join(' ') || undefined
	return (
		<div className='grid min-w-0'>
			<style href='password-field-reveal' precedence='default'>
				{revealKeyframes}
			</style>
			<label className={cn('mb-2 text-sm font-medium', hideLabel && 'sr-only')} htmlFor={controlId}>
				{label}
			</label>
			<div className='flex min-h-control-md items-center rounded-control border border-border-strong bg-surface pr-[calc((var(--spacing-control-md)-2px-30px)/2)] pl-3 transition-[border-color] duration-110 ease-standard focus-within:border-foreground hover:not-focus-within:not-has-[input[aria-invalid=true]]:border-foreground has-[input[aria-invalid=true]]:border-danger'>
				<input
					{...props}
					id={controlId}
					type={visible ? 'text' : 'password'}
					// Set only after the first toggle, so the value resolves on each change but never on mount.
					data-reveal={toggled ? (visible ? 'shown' : 'hidden') : undefined}
					aria-describedby={describedBy}
					className={cn(
						'w-full min-w-0 border-0 bg-transparent text-sm text-foreground placeholder:text-muted motion-safe:data-[reveal=hidden]:animate-[password-reveal-hidden_170ms_var(--ease-enter)] motion-safe:data-[reveal=shown]:animate-[password-reveal-shown_170ms_var(--ease-enter)]',
						className,
					)}
				/>
				{/* The shell leaves the 30px button a 2px inset, so the ring sits inside it instead of over the shell border. */}
				<button
					type='button'
					className='grid size-[30px] flex-none press place-items-center rounded-control text-muted [--focus-outline-offset:-1px] hover:bg-surface-muted hover:text-foreground aria-pressed:text-foreground'
					onClick={() => {
						setVisible(current => !current)
						setToggled(true)
					}}
					aria-label={visible ? messages.hidePassword : messages.showPassword}
					aria-pressed={visible}
				>
					<EyeMorph slashed={visible} />
				</button>
			</div>
			<FieldMessage id={hintId} text={description} />
		</div>
	)
}

// One eye that a slash draws across, cutting the eye stroke beneath it, instead of swapping two icons.
function EyeMorph({ slashed }: { slashed: boolean }) {
	const reduced = useReducedMotion()
	const maskId = `eye-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
	const slash = { pathLength: slashed ? 1 : 0, opacity: slashed ? 1 : 0 }
	const transition = reduced
		? { duration: 0 }
		: {
				pathLength: { duration: motionTokens.duration.standard, ease: motionTokens.ease.standard },
				opacity: { duration: motionTokens.duration.instant },
			}
	return (
		<svg
			width={18}
			height={18}
			viewBox='0 0 24 24'
			fill='none'
			stroke='currentColor'
			strokeWidth={1.75}
			strokeLinecap='round'
			strokeLinejoin='round'
			aria-hidden='true'
		>
			<mask id={maskId} maskUnits='userSpaceOnUse' x='0' y='0' width='24' height='24'>
				<rect width='24' height='24' fill='white' stroke='none' />
				<motion.path
					d='M2 2l20 20'
					stroke='black'
					strokeWidth={5}
					initial={false}
					animate={slash}
					transition={transition}
				/>
			</mask>
			<g mask={`url(#${maskId})`}>
				<path d='M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' />
				<circle cx='12' cy='12' r='3' />
			</g>
			<motion.path d='M2 2l20 20' initial={false} animate={slash} transition={transition} />
		</svg>
	)
}

function FieldMessage({ id, text }: { id?: string; text?: string }) {
	return (
		<AnimatePresence initial={false}>
			{text ? <MessageRow key='message' id={id} text={text} /> : null}
		</AnimatePresence>
	)
}

// The row tracks the measured copy, so a longer message that wraps opens its next line instead of snapping.
function MessageRow({ id, text }: { id?: string; text: string }) {
	const reduced = useReducedMotion()
	const copyRef = useRef<HTMLSpanElement>(null)
	const [height, setHeight] = useState<number | 'auto'>('auto')
	useEffect(() => {
		const node = copyRef.current
		if (!node) return
		const observer = new ResizeObserver(entries => {
			for (const entry of entries) setHeight(entry.borderBoxSize[0]!.blockSize)
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [])
	return (
		<motion.span
			className='block overflow-hidden'
			initial={{ height: 0, opacity: 0 }}
			animate={{ height, opacity: 1 }}
			exit={{
				height: 0,
				opacity: 0,
				transition: reduced
					? { duration: 0 }
					: {
							height: motionTokens.spring.smooth,
							opacity: { duration: motionTokens.duration.instant },
						},
			}}
			transition={
				reduced
					? { duration: 0 }
					: {
							height: motionTokens.spring.smooth,
							opacity: { duration: motionTokens.duration.fast },
						}
			}
		>
			<motion.span
				ref={copyRef}
				id={id}
				className='block pt-2 text-xs text-muted'
				initial={reduced ? false : { y: '0.35em', filter: `blur(${motionTokens.blur.soft}px)` }}
				animate={{ y: 0, filter: 'blur(0px)' }}
				transition={{
					duration: reduced ? 0 : motionTokens.duration.standard,
					ease: motionTokens.ease.enter,
				}}
			>
				<MotionText text={text} />
			</motion.span>
		</motion.span>
	)
}

// Changed words rise in and unblur while unchanged words hold still. Assistive tech reads the plain copy.
function MotionText({ text }: { text: string }) {
	const reduced = useReducedMotion()
	const words = text.split(' ')
	return (
		<>
			<span className='sr-only'>{text}</span>
			{/* Words that pop out to leave are measured against this box, so it must be the positioned parent. */}
			<span className='relative block' aria-hidden='true'>
				<AnimatePresence initial={false} mode='popLayout'>
					{words.map((word, index) => (
						<motion.span
							key={`${index}:${word}`}
							className='inline-block whitespace-pre'
							initial={
								reduced
									? { opacity: 0 }
									: { opacity: 0, y: '0.35em', filter: `blur(${motionTokens.blur.soft}px)` }
							}
							animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
							exit={
								reduced
									? { opacity: 0, transition: { duration: 0 } }
									: {
											opacity: 0,
											y: '-0.35em',
											filter: `blur(${motionTokens.blur.subtle}px)`,
											transition: {
												duration: motionTokens.duration.exit,
												ease: motionTokens.ease.exit,
											},
										}
							}
							transition={
								reduced
									? { duration: motionTokens.duration.instant }
									: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter }
							}
						>
							{index < words.length - 1 ? `${word} ` : word}
						</motion.span>
					))}
				</AnimatePresence>
			</span>
		</>
	)
}
