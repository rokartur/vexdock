import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconX } from '@tabler/icons-react'
import { cn } from 'cn'
import {
	animate,
	AnimatePresence,
	motion,
	type Transition,
	useMotionValue,
	useReducedMotion,
	type Variants,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type SelectionAction = {
	label: string
	icon?: ReactNode
	onClick: () => void
	destructive?: boolean
}

type SelectionToolbarProps = {
	count: number
	actions: SelectionAction[]
	onClear: () => void
	noun?: string
}

const { blur, duration, ease, spring } = motionTokens
const instant: Transition = { duration: duration.instant }
const fadeIn: Transition = { duration: duration.standard, ease: [...ease.enter] }
const fadeOut: Transition = { duration: duration.fast, ease: [...ease.standard] }
// A resize this soon after the count changed is the count's own, so it springs; any other resize jumps.
const WIDTH_SPRING_WINDOW_MS = 490

const digitMotion: Variants = {
	enter: (direction: number) => ({
		opacity: 0,
		y: direction > 0 ? '0.6em' : '-0.6em',
		filter: `blur(${blur.subtle}px)`,
	}),
	rest: { opacity: 1, y: 0, filter: 'blur(0px)' },
	exit: (direction: number) => ({
		opacity: 0,
		y: direction > 0 ? '-0.6em' : '0.6em',
		filter: `blur(${blur.subtle}px)`,
		transition: fadeOut,
	}),
}
const reducedDigitMotion: Variants = {
	enter: { opacity: 0 },
	rest: { opacity: 1 },
	exit: { opacity: 0, transition: instant },
}

const buttonClass =
	'inline-flex min-h-[34px] items-center justify-center gap-[7px] rounded-[calc(var(--radius-panel)-6px)] bg-transparent text-xs whitespace-nowrap text-foreground hover:bg-surface-muted active:bg-surface-pressed'

export function SelectionToolbar({ count, actions, onClear, noun = 'item' }: SelectionToolbarProps) {
	const reduced = useReducedMotion() ?? false
	return (
		<AnimatePresence initial={false}>
			{count > 0 && (
				<motion.div
					key='selection-toolbar'
					role='toolbar'
					aria-label='Selection actions'
					className='inline-flex min-h-[46px] max-w-full origin-bottom items-center gap-2 rounded-panel border bg-surface-raised py-[5px] pr-1.5 pl-3.5 text-foreground shadow-raised max-[520px]:w-full max-[520px]:flex-wrap'
					initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.97 }}
					animate={{ opacity: 1, y: 0, scale: 1 }}
					exit={
						reduced
							? { opacity: 0, transition: instant }
							: {
									opacity: 0,
									y: 6,
									scale: 0.98,
									transition: { duration: duration.exit, ease: [...ease.standard] },
								}
					}
					transition={
						reduced
							? instant
							: { ...spring.smooth, opacity: { duration: duration.fast, ease: [...ease.enter] } }
					}
				>
					<span className='relative flex-none text-xs whitespace-nowrap text-secondary max-[520px]:min-w-0 max-[520px]:flex-auto'>
						<Count count={count} noun={noun} reduced={reduced} />
						<span className='sr-only' aria-live='polite'>
							{`${count} ${noun}${count === 1 ? '' : 's'} selected`}
						</span>
					</span>
					{actions.length > 0 && (
						<>
							<span aria-hidden='true' className='h-5 w-px flex-none bg-border max-[520px]:hidden' />
							<div className='flex min-w-0 items-center gap-0.5 max-[520px]:order-2 max-[520px]:flex-[1_0_100%] max-[520px]:flex-wrap max-[520px]:border-t max-[520px]:border-border-subtle max-[520px]:pt-1'>
								{actions.map(action => (
									<button
										key={action.label}
										type='button'
										className={cn(
											buttonClass,
											'press px-2.5 max-[520px]:flex-auto max-[520px]:px-1.5',
											action.destructive &&
												'text-danger hover:bg-[color-mix(in_oklab,var(--danger)_9%,var(--surface))] active:bg-[color-mix(in_oklab,var(--danger)_12%,var(--surface))]',
										)}
										onClick={action.onClick}
									>
										{action.icon && (
											<span aria-hidden='true' className='inline-flex items-center'>
												{action.icon}
											</span>
										)}
										{action.label}
									</button>
								))}
							</div>
						</>
					)}
					<button
						type='button'
						aria-label='Clear selection'
						className={cn(
							buttonClass,
							'w-[34px] flex-none p-0 text-muted [transition:background-color_110ms_var(--ease-standard),color_110ms_var(--ease-standard),scale_400ms_var(--ease-spring)] active:[transition-duration:110ms,110ms,85ms] active:ease-standard motion-safe:active:scale-96 max-[520px]:order-1',
						)}
						onClick={onClear}
					>
						<IconX size={15} stroke={2} aria-hidden='true' />
					</button>
				</motion.div>
			)}
		</AnimatePresence>
	)
}

function Count({ count, noun, reduced }: { count: number; noun: string; reduced: boolean }) {
	const [last, setLast] = useState({ count, direction: 1 })
	if (last.count !== count) setLast({ count, direction: count > last.count ? 1 : -1 })

	const row = useRef<HTMLSpanElement>(null)
	const width = useMotionValue<number | string>('auto')
	const lastCount = useRef(count)
	const springUntil = useRef(0)

	useLayoutEffect(() => {
		if (lastCount.current === count) return
		lastCount.current = count
		springUntil.current = performance.now() + WIDTH_SPRING_WINDOW_MS
	}, [count])

	useEffect(() => {
		const element = row.current
		if (!element) return
		let measured = false
		const observer = new ResizeObserver(([entry]) => {
			const next = entry!.contentRect.width
			if (!next || !measured || reduced || performance.now() > springUntil.current) {
				measured = next > 0
				width.jump(next || 'auto')
				return
			}
			animate(width, next, spring.morph)
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [reduced, width])

	const layout = reduced ? false : 'position'
	return (
		<motion.span aria-hidden='true' className='inline-flex min-w-0' style={{ width }}>
			<span ref={row} className='inline-flex flex-none items-baseline whitespace-pre'>
				<span className='relative inline-flex min-w-[1ch] font-medium text-accent tabular-nums'>
					<AnimatePresence mode='popLayout' initial={false} custom={last.direction}>
						<motion.span
							key={count}
							className='inline-block'
							custom={last.direction}
							variants={reduced ? reducedDigitMotion : digitMotion}
							initial='enter'
							animate='rest'
							exit='exit'
							transition={reduced ? instant : { ...spring.snappy, opacity: fadeIn, filter: fadeIn }}
						>
							{count}
						</motion.span>
					</AnimatePresence>
				</span>
				<motion.span
					className='relative inline-block'
					layout={layout}
					layoutDependency={count}
					transition={spring.morph}
				>
					{` ${noun}`}
					<AnimatePresence mode='popLayout' initial={false}>
						{count !== 1 && (
							<motion.span
								key='plural'
								className='inline-block'
								initial={reduced ? { opacity: 0 } : { opacity: 0, filter: `blur(${blur.subtle}px)` }}
								animate={{ opacity: 1, filter: 'blur(0px)' }}
								exit={
									reduced
										? { opacity: 0, transition: { duration: 0 } }
										: { opacity: 0, filter: `blur(${blur.subtle}px)`, transition: fadeOut }
								}
								transition={reduced ? instant : fadeIn}
							>
								s
							</motion.span>
						)}
					</AnimatePresence>
					<motion.span
						className='inline-block'
						layout={layout}
						layoutDependency={count}
						transition={spring.morph}
					>
						{' selected'}
					</motion.span>
				</motion.span>
			</span>
		</motion.span>
	)
}
