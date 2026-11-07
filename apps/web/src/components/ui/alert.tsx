import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { IconAlertTriangle, IconCheck, IconCircleX, IconInfoCircle, IconX } from '@tabler/icons-react'
import { cn } from 'cn'
import {
	AnimatePresence,
	animate,
	motion,
	useIsPresent,
	useMotionValue,
	useReducedMotion,
	type AnimationPlaybackControls,
	type HTMLMotionProps,
	type MotionProps,
	type TargetAndTransition,
	type Transition,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

const tones = {
	info: { icon: IconInfoCircle, color: 'text-accent' },
	success: { icon: IconCheck, color: 'text-success' },
	warning: { icon: IconAlertTriangle, color: 'text-warning' },
	danger: { icon: IconCircleX, color: 'text-danger' },
} satisfies Record<string, { icon: typeof IconInfoCircle; color: string }>

export type AlertTone = keyof typeof tones

export type AlertProps = HTMLAttributes<HTMLDivElement> & {
	tone?: AlertTone
	title: string
	children?: ReactNode
	open?: boolean
	onDismiss?: () => void
}

type AlertBoxProps = Omit<AlertProps, 'open'> & { reduce: boolean | null; animateIcon?: boolean }

const { blur, duration, ease, spring } = motionTokens
const exitFast: Transition = { duration: duration.fast, ease: [...ease.standard] }
const textIn: TargetAndTransition = { opacity: 0, y: '0.3em', filter: `blur(${blur.soft}px)` }
const textOut: TargetAndTransition = {
	opacity: 0,
	y: '-0.3em',
	filter: `blur(${blur.subtle}px)`,
	transition: exitFast,
}
const iconIn: TargetAndTransition = { opacity: 0, scale: 0.6, filter: `blur(${blur.subtle}px)` }
const shown: TargetAndTransition = { opacity: 1, y: '0em', scale: 1, filter: 'blur(0px)' }
const fadeOut: TargetAndTransition = { opacity: 0, transition: { duration: duration.instant } }

export function Alert({ open, onDismiss, ...props }: AlertProps) {
	const reduce = useReducedMotion()
	const [dismissed, setDismissed] = useState(false)
	const shell = useRef<HTMLDivElement>(null)
	if (open === undefined && !onDismiss) return <AlertBox {...props} reduce={reduce} />

	const isOpen = open ?? !dismissed
	const dismiss = onDismiss && (() => (open === undefined ? setDismissed(true) : onDismiss()))
	const presence: Transition = reduce
		? { duration: 0 }
		: { height: spring.smooth, opacity: { duration: duration.standard, ease: [...ease.enter] } }
	const exit: TargetAndTransition = {
		height: 0,
		opacity: 0,
		transition: reduce ? { duration: 0 } : { height: spring.smooth, opacity: exitFast },
	}
	// Clips only while the height moves, so the dismiss focus ring stays visible at rest.
	const setClip = (overflow: string) => {
		if (shell.current) shell.current.style.overflow = overflow
	}

	return (
		<AnimatePresence
			initial={false}
			onExitComplete={() => {
				if (open === undefined) onDismiss?.()
			}}
		>
			{isOpen && (
				<motion.div
					key='alert'
					ref={shell}
					className='min-w-0'
					initial={{ height: 0, opacity: 0 }}
					animate={{ height: 'auto', opacity: 1 }}
					exit={exit}
					transition={presence}
					onAnimationStart={() => setClip('hidden')}
					onAnimationComplete={() => setClip('')}
				>
					<AlertBox {...props} reduce={reduce} onDismiss={dismiss} animateIcon />
				</motion.div>
			)}
		</AnimatePresence>
	)
}

function AlertBox({
	tone = 'info',
	title,
	children,
	className,
	reduce,
	onDismiss,
	animateIcon = false,
	...props
}: AlertBoxProps) {
	const Icon = tones[tone].icon
	const text = typeof children === 'string' || typeof children === 'number' ? String(children) : null
	const hasDetails = children !== undefined && children !== null && children !== false && children !== ''
	const enter: Transition = reduce
		? { duration: duration.instant }
		: { duration: duration.standard, ease: [...ease.enter] }
	const swap: MotionProps = {
		initial: reduce ? { opacity: 0 } : textIn,
		animate: shown,
		exit: reduce ? fadeOut : textOut,
		transition: enter,
	}

	return (
		<div
			{...props}
			role={tone === 'danger' ? 'alert' : 'status'}
			// vexdock: rounded-surface, not Arc's rounded-control, so an alert's corner matches the cards around it.
			className={cn('flex items-start gap-2.5 rounded-surface border bg-surface p-3 shadow-resting', className)}
		>
			{/* A new tone morphs its icon in place; a newly shown alert gives the icon a small settle. */}
			<motion.span
				className={cn(
					'relative mt-px grid size-4.5 shrink-0 place-items-center [&_svg]:block',
					tones[tone].color,
				)}
				initial={animateIcon && !reduce ? iconIn : false}
				animate={shown}
				transition={spring.snappy}
			>
				<AnimatePresence mode='popLayout' initial={false}>
					<Swap
						key={tone}
						className='relative grid shrink-0 place-items-center'
						initial={reduce ? { opacity: 0 } : iconIn}
						animate={shown}
						exit={reduce ? fadeOut : { ...iconIn, transition: exitFast }}
						transition={reduce ? enter : spring.snappy}
					>
						<Icon size={18} stroke={2} aria-hidden />
					</Swap>
				</AnimatePresence>
			</motion.span>
			<HeightFrame className='min-w-0 flex-1' reduce={reduce} morphKey={`${title}\n${hasDetails}\n${text ?? ''}`}>
				<strong className='relative block text-sm font-medium'>
					<AnimatePresence mode='popLayout' initial={false}>
						<Swap key={title} className='block' {...swap}>
							{title}
						</Swap>
					</AnimatePresence>
				</strong>
				<AnimatePresence mode='popLayout' initial={false}>
					{hasDetails && (
						// vexdock: a div, not Arc's p: pages pass a list or a code block as details, which a p cannot hold.
						<motion.div key='details' className='relative mt-1 text-xs text-secondary' {...swap}>
							{text === null ? (
								children
							) : (
								<AnimatePresence mode='popLayout' initial={false}>
									<Swap key={text} className='block' {...swap}>
										{text}
									</Swap>
								</AnimatePresence>
							)}
						</motion.div>
					)}
				</AnimatePresence>
			</HeightFrame>
			{onDismiss && (
				<button
					type='button'
					aria-label={`Dismiss: ${title}`}
					onClick={onDismiss}
					className='-my-[5px] -me-1.5 grid size-7 shrink-0 place-items-center rounded-full text-muted [transition:scale_400ms_var(--ease-spring),background-color_110ms_var(--ease-standard),color_110ms_var(--ease-standard)] hover:bg-surface-muted hover:text-foreground motion-safe:active:scale-96 motion-safe:active:[transition-duration:85ms] motion-safe:active:ease-standard'
				>
					<IconX size={16} stroke={1.75} aria-hidden />
				</button>
			)}
		</div>
	)
}

// Outgoing copies are hidden from assistive tech while they fade, so the live region reads only the current text.
function Swap(props: HTMLMotionProps<'span'>) {
	const present = useIsPresent()
	return <motion.span {...props} aria-hidden={present ? props['aria-hidden'] : true} />
}

// After `morphKey` changes the height springs from the old size to the new one, then returns to auto so passive reflows (a resize, a font swap) follow at once.
function HeightFrame({
	className,
	reduce,
	morphKey,
	children,
}: {
	className: string
	reduce: boolean | null
	morphKey: string
	children: ReactNode
}) {
	const frame = useRef<HTMLDivElement>(null)
	const content = useRef<HTMLDivElement>(null)
	const height = useMotionValue<number | 'auto'>('auto')
	const changedAt = useRef(0)

	useLayoutEffect(() => {
		changedAt.current = performance.now()
	}, [morphKey])

	useEffect(() => {
		// vexdock: held here, not read from the ref, as skeleton.tsx does; the observer fires once more after an unmount
		// has already cleared the ref, and `frame.current!` threw.
		const frameNode = frame.current!
		let last: number | undefined
		let controls: AnimationPlaybackControls | undefined
		const settle = () => {
			height.jump('auto')
			Object.assign(frameNode.style, { overflow: '', height: 'auto' })
		}
		const observer = new ResizeObserver(([entry]) => {
			const next = entry!.borderBoxSize[0]!.blockSize
			const current = height.get()
			const from = typeof current === 'number' ? current : last
			last = next
			controls?.stop()
			if (reduce || from === undefined || from === next || performance.now() - changedAt.current > 120)
				return settle()
			// Pin the old height before this frame paints, then spring to the new one.
			Object.assign(frameNode.style, { overflow: 'hidden', height: `${from}px` })
			controls = animate(height, [from, next], { ...spring.smooth, onComplete: settle })
		})
		observer.observe(content.current!)
		return () => {
			observer.disconnect()
			controls?.stop()
		}
	}, [height, reduce])

	return (
		<motion.div ref={frame} className={className} style={{ height }}>
			<div ref={content} className='relative'>
				{children}
			</div>
		</motion.div>
	)
}
