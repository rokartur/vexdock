import { useEffect, type HTMLAttributes } from 'react'
import { IconCheck } from '@tabler/icons-react'
import { cn } from 'cn'
import {
	AnimatePresence,
	animate,
	motion,
	useIsPresent,
	useMotionValue,
	useReducedMotion,
	useTransform,
	type HTMLMotionProps,
	type TargetAndTransition,
	type Transition,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
	value?: number
	max?: number
	label?: string
	showValue?: boolean
}

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

// Outgoing copies are hidden from assistive tech while they fade.
function Swap(props: HTMLMotionProps<'span'>) {
	const present = useIsPresent()
	return <motion.span {...props} aria-hidden={present ? props['aria-hidden'] : true} />
}

export function Progress({ value = 0, max = 100, label, showValue = false, className, ...props }: ProgressProps) {
	const reduce = useReducedMotion()
	const safeMax = max > 0 ? max : 100
	const safeValue = Math.min(Math.max(value, 0), safeMax)
	const percentage = Math.round((safeValue / safeMax) * 100)
	const complete = percentage >= 100
	// One spring drives both the fill and the counted label, so the number always matches the bar.
	const progress = useMotionValue(percentage)
	// The fill slides in from the left instead of scaling, so its rounded end keeps its shape at every value.
	const x = useTransform(progress, latest => `${Math.min(Math.max(latest, 0), 100) - 100}%`)
	const counted = useTransform(progress, latest => `${Math.round(Math.min(Math.max(latest, 0), 100))}%`)

	useEffect(() => {
		if (reduce) {
			progress.jump(percentage)
			return
		}
		const controls = animate(progress, percentage, spring.smooth)
		return () => controls.stop()
	}, [percentage, progress, reduce])

	const enter: Transition = reduce
		? { duration: duration.instant }
		: { duration: duration.standard, ease: [...ease.enter] }

	return (
		<div
			{...props}
			className={cn('group w-full text-sm text-secondary', className)}
			data-complete={complete ? '' : undefined}
			role='progressbar'
			aria-label={label ?? 'Progress'}
			aria-valuemin={0}
			aria-valuemax={safeMax}
			aria-valuenow={safeValue}
			aria-valuetext={`${percentage}%`}
		>
			{label || showValue ? (
				<div className='mb-2 flex justify-between gap-3'>
					{label ? (
						<span className='relative min-w-0'>
							<AnimatePresence mode='popLayout' initial={false}>
								<Swap
									key={label}
									className='block'
									initial={reduce ? { opacity: 0 } : textIn}
									animate={shown}
									exit={reduce ? fadeOut : textOut}
									transition={enter}
								>
									{label}
								</Swap>
							</AnimatePresence>
						</span>
					) : (
						<span />
					)}
					{showValue ? (
						<span className='inline-flex flex-none items-center gap-1 text-muted tabular-nums'>
							{/* Completion lands as the fill arrives: a check settles in beside the final count. */}
							<AnimatePresence initial={false}>
								{complete && (
									<motion.span
										key='done'
										className='grid place-items-center text-success'
										initial={reduce ? { opacity: 0 } : iconIn}
										animate={shown}
										exit={reduce ? fadeOut : { ...iconIn, transition: exitFast }}
										transition={reduce ? enter : { ...spring.snappy, delay: duration.standard }}
									>
										<IconCheck size={14} stroke={1.75} aria-hidden='true' />
									</motion.span>
								)}
							</AnimatePresence>
							{/* The hidden "100%" row reserves the widest count, so the check never shifts as the number gains a digit. */}
							<motion.span className="inline-grid justify-items-end before:invisible before:h-0 before:overflow-hidden before:content-['100%']">
								{counted}
							</motion.span>
						</span>
					) : null}
				</div>
			) : null}
			<div className='h-1.75 overflow-hidden rounded-full border border-border bg-surface-muted'>
				<motion.span
					className='block size-full rounded-[inherit] bg-accent transition-[background-color] duration-170 ease-standard group-data-complete:bg-success group-data-complete:delay-140 motion-reduce:transition-none'
					style={{ x }}
				/>
			</div>
		</div>
	)
}
