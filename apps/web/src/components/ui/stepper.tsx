import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from 'cn'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type StepperOrientation = 'horizontal' | 'vertical'
export type StepperStatus = 'complete' | 'current' | 'upcoming' | 'error'

export interface StepperStep {
	id: string
	label: string
	description?: string
	error?: string
}

export interface StepperProps {
	steps: StepperStep[]
	current: number
	orientation?: StepperOrientation
	onStepSelect?: (index: number) => void
	details?: 'all' | 'current'
	compact?: boolean
	label?: string
	completeLabel?: string
	className?: string
}

type GlyphKind = 'number' | 'check' | 'error'

const { blur, duration, ease, spring, stagger } = motionTokens
const toBlur = (radius: number) => `blur(${radius}px)`
const still = { duration: 0 } as const
const leave = { duration: duration.fast, ease: [...ease.standard] } as const
const settle = { duration: duration.standard, ease: [...ease.enter] } as const
const textFrom = { opacity: 0, y: '0.3em', filter: toBlur(blur.soft) }
const textRest = { opacity: 1, y: 0, filter: toBlur(0) }
const textGone = { opacity: 0, y: '-0.3em', filter: toBlur(blur.subtle) }
const glyphFrom = { opacity: 0, scale: 0.5, filter: toBlur(blur.subtle) }
const glyphRest = { opacity: 1, scale: 1, filter: toBlur(0) }

const statusText: Record<StepperStatus, string> = {
	complete: 'Completed',
	current: '',
	upcoming: 'Not started',
	error: 'Error',
}

const discTone: Record<StepperStatus, string> = {
	complete: 'bg-accent text-accent-foreground shadow-[inset_0_0_0_1px_var(--accent)]',
	current: 'text-foreground shadow-[inset_0_0_0_1.5px_var(--accent)]',
	upcoming: '',
	error: 'bg-[color-mix(in_oklab,var(--danger)_10%,var(--surface))] text-danger shadow-[inset_0_0_0_1.5px_var(--danger)]',
}

const discHover: Record<StepperStatus, string> = {
	complete: 'group-hover/head:bg-accent-strong group-hover/head:shadow-[inset_0_0_0_1px_var(--accent-strong)]',
	current: '',
	upcoming: '',
	error: 'group-hover/head:bg-[color-mix(in_oklab,var(--danger)_18%,var(--surface))]',
}

const labelTone: Record<StepperStatus, string> = {
	complete: 'text-secondary',
	current: 'text-foreground',
	upcoming: 'text-muted',
	error: 'text-foreground',
}

const descriptionClass = 'block pt-0.5 text-xs font-normal [overflow-wrap:break-word] text-muted'
const errorClass = 'block pt-0.5 text-xs font-normal [overflow-wrap:break-word] text-danger'

export function Stepper({
	steps,
	current,
	orientation = 'horizontal',
	onStepSelect,
	details = 'all',
	compact = false,
	label = 'Progress',
	completeLabel = 'All steps complete',
	className,
}: StepperProps) {
	const reduced = useReducedMotion() ?? false
	const count = steps.length
	const active = Math.min(Math.max(Math.round(current), 0), count)
	// Remember where progress came from, so a jump across several steps fills or drains its connectors one after another.
	const [travel, setTravel] = useState({ to: active, from: active })
	if (travel.to !== active) setTravel({ to: active, from: travel.to })
	const from = travel.from
	const delayAt = (index: number) => {
		if (reduced) return 0
		if (active > from) return index >= from && index < active ? (index - from) * stagger.line : 0
		return index >= active && index < from ? (from - 1 - index) * stagger.line : 0
	}
	const ringDelay = reduced ? 0 : Math.max(0, Math.abs(active - from) - 1) * stagger.line + 0.084
	const interactive = Boolean(onStepSelect)
	const vertical = orientation === 'vertical'
	const now = active >= count ? undefined : steps[active]

	function onKeyDown(event: KeyboardEvent<HTMLOListElement>) {
		const rtl = !vertical && getComputedStyle(event.currentTarget).direction === 'rtl'
		const back = ['ArrowUp', rtl ? 'ArrowRight' : 'ArrowLeft']
		const ahead = ['ArrowDown', rtl ? 'ArrowLeft' : 'ArrowRight']
		if (![...back, ...ahead, 'Home', 'End'].includes(event.key)) return
		const targets = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-reachable]'))
		const at = targets.findIndex(target => target === event.target)
		if (at < 0) return
		event.preventDefault()
		let next = back.includes(event.key) ? Math.max(0, at - 1) : Math.min(targets.length - 1, at + 1)
		if (event.key === 'Home') next = 0
		if (event.key === 'End') next = targets.length - 1
		targets[next]?.focus()
	}

	const Root = interactive ? 'nav' : 'div'
	return (
		<Root
			className={cn('min-w-0 text-foreground', !vertical && '@container/stepper w-full', className)}
			aria-label={label}
			role={interactive ? undefined : 'group'}
		>
			<ol
				className='grid'
				style={
					vertical
						? undefined
						: {
								gridTemplateColumns: count > 1 ? `repeat(${count - 1}, minmax(0, 1fr)) auto` : 'auto',
							}
				}
				onKeyDown={interactive ? onKeyDown : undefined}
			>
				{steps.map((step, index) => {
					const isCurrent = index === active
					const status: StepperStatus = step.error
						? 'error'
						: index < active
							? 'complete'
							: isCurrent
								? 'current'
								: 'upcoming'
					const clickable = interactive && index < active
					const detail = step.error ?? (details === 'all' || isCurrent ? step.description : undefined)
					const kind: GlyphKind = step.error ? 'error' : index < active ? 'check' : 'number'
					const content: ReactNode = (
						<>
							<Marker
								number={index + 1}
								kind={kind}
								status={status}
								current={isCurrent}
								clickable={clickable}
								glyphDelay={delayAt(index)}
								ringDelay={ringDelay}
								reduced={reduced}
							/>
							<span
								className={cn(
									'grid min-w-0',
									vertical ? 'pt-1' : '@max-[30rem]/stepper:sr-only',
									compact && 'sr-only',
								)}
							>
								<span
									className={cn(
										'block text-sm/5 font-medium [overflow-wrap:break-word] transition-colors duration-170',
										labelTone[status],
										clickable && 'group-hover/head:text-foreground',
									)}
								>
									{step.label}
								</span>
								{statusText[status] ? <span className='sr-only'>, {statusText[status]}</span> : null}
								<SwapText
									text={detail}
									className={step.error ? errorClass : descriptionClass}
									reduced={reduced}
								/>
							</span>
						</>
					)
					const headClass = cn(
						'group/head grid rounded-[0.375rem] text-start [--focus-outline-offset:4px]',
						vertical
							? cn(
									'w-full items-start gap-x-2.5',
									compact ? 'grid-cols-[1.75rem] gap-x-0' : 'grid-cols-[1.75rem_minmax(0,1fr)]',
								)
							: 'w-fit max-w-full justify-items-start gap-y-2.5',
					)
					return (
						<li
							key={step.id}
							className={cn(
								'relative min-w-0',
								vertical ? (compact ? 'not-last:pb-5' : 'not-last:pb-4') : 'not-last:pe-3',
							)}
							data-status={status}
						>
							{index < count - 1 ? (
								<span
									className={cn(
										'pointer-events-none absolute overflow-hidden rounded-full bg-border',
										vertical
											? 'start-[calc(0.875rem-1px)] top-[calc(1.75rem+6px)] bottom-1.5 w-0.5'
											: 'start-9 end-2 top-[calc(0.875rem-1px)] h-0.5',
									)}
									aria-hidden='true'
								>
									<motion.span
										key={orientation}
										className={cn(
											'absolute inset-0 rounded-[inherit] bg-accent',
											vertical ? 'origin-top' : 'origin-left rtl:origin-right',
										)}
										initial={false}
										animate={
											vertical
												? { scaleY: index < active ? 1 : 0 }
												: { scaleX: index < active ? 1 : 0 }
										}
										transition={reduced ? still : { ...spring.smooth, delay: delayAt(index) }}
									/>
								</span>
							) : null}
							{interactive ? (
								<button
									type='button'
									className={headClass}
									data-clickable={clickable || undefined}
									data-reachable={index <= active || undefined}
									aria-current={isCurrent ? 'step' : undefined}
									aria-disabled={clickable ? undefined : true}
									tabIndex={clickable ? undefined : -1}
									onClick={clickable ? () => onStepSelect?.(index) : undefined}
								>
									{content}
								</button>
							) : (
								<span className={headClass} aria-current={isCurrent ? 'step' : undefined}>
									{content}
								</span>
							)}
						</li>
					)
				})}
			</ol>
			{vertical ? null : (
				<span
					className={cn('mt-2.5 @max-[30rem]/stepper:grid', compact ? 'grid' : 'hidden')}
					aria-hidden='true'
				>
					<SwapText
						text={now?.label ?? completeLabel}
						className='block text-sm/5 font-medium text-foreground'
						reduced={reduced}
					/>
					<SwapText
						text={now?.error ?? now?.description}
						className={now?.error ? errorClass : descriptionClass}
						reduced={reduced}
					/>
				</span>
			)}
			<span className='sr-only' aria-live='polite'>
				{now ? `Step ${active + 1} of ${count}: ${now.label}` : completeLabel}
			</span>
		</Root>
	)
}

// Its slot springs to the new height while the text changes, so a message that wraps eases the steps below it down;
// unrelated resizes (fonts, container width) follow exactly.
function SwapText({ text, className, reduced }: { text?: string; className: string; reduced: boolean }) {
	const inner = useRef<HTMLSpanElement>(null)
	const armedUntil = useRef(0)
	const height = useMotionValue<number | 'auto'>('auto')
	useLayoutEffect(() => {
		armedUntil.current = performance.now() + 700
	}, [text])
	useEffect(() => {
		const node = inner.current
		if (!node) return
		let measured = false
		const observer = new ResizeObserver(() => {
			const next = node.offsetHeight
			if (!measured || reduced || performance.now() > armedUntil.current) {
				measured = true
				height.jump(next)
				return
			}
			animate(height, next, spring.smooth)
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [height, reduced])
	return (
		<motion.span className='block' style={{ height }}>
			{/* Changing text pops out of flow against this box while it leaves, so it must be the positioned parent. */}
			<span ref={inner} className='relative block'>
				<AnimatePresence mode='popLayout' initial={false}>
					{text ? (
						<motion.span
							key={`${className}:${text}`}
							className={className}
							initial={textFrom}
							animate={textRest}
							exit={{ ...textGone, transition: reduced ? still : leave }}
							transition={reduced ? still : settle}
						>
							{text}
						</motion.span>
					) : null}
				</AnimatePresence>
			</span>
		</motion.span>
	)
}

function Marker({
	number,
	kind,
	status,
	current,
	clickable,
	glyphDelay,
	ringDelay,
	reduced,
}: {
	number: number
	kind: GlyphKind
	status: StepperStatus
	current: boolean
	clickable: boolean
	glyphDelay: number
	ringDelay: number
	reduced: boolean
}) {
	return (
		<span className='relative grid size-7 flex-none place-items-center' aria-hidden='true'>
			<AnimatePresence initial={false}>
				{current ? (
					<motion.span
						key='ring'
						className={cn(
							'absolute -inset-1 rounded-full transition-colors duration-170',
							status === 'error' ? 'bg-danger/16' : 'bg-accent-subtle',
						)}
						initial={{ opacity: 0, scale: 0.6 }}
						animate={{ opacity: 1, scale: 1 }}
						exit={{ opacity: 0, scale: 0.6, transition: reduced ? still : leave }}
						transition={
							reduced
								? still
								: {
										scale: { ...spring.snappy, delay: ringDelay },
										opacity: { duration: duration.fast, delay: ringDelay },
									}
						}
					/>
				) : null}
			</AnimatePresence>
			<span
				className={cn(
					'relative grid size-full place-items-center rounded-full bg-surface text-xs/none font-medium text-muted tabular-nums shadow-[inset_0_0_0_1px_var(--border-strong)]',
					'[transition:background-color_170ms_var(--ease-standard),box-shadow_170ms_var(--ease-standard),color_170ms_var(--ease-standard),scale_400ms_var(--ease-spring)]',
					discTone[status],
					clickable && cn(discHover[status], 'motion-safe:group-active/head:scale-92'),
				)}
			>
				<AnimatePresence initial={false}>
					<Glyph key={kind} kind={kind} number={number} delay={glyphDelay} reduced={reduced} />
				</AnimatePresence>
			</span>
		</span>
	)
}

// The number, check and alert share one spot: the outgoing glyph shrinks away while the next one pops in and draws its stroke.
function Glyph({ kind, number, delay, reduced }: { kind: GlyphKind; number: number; delay: number; reduced: boolean }) {
	const pop = reduced
		? still
		: {
				scale: { ...spring.snappy, delay },
				opacity: { duration: duration.fast, delay },
				filter: { duration: duration.fast, delay },
			}
	const exit = { ...glyphFrom, transition: reduced ? still : leave }
	const draw = reduced ? still : { ...settle, delay: delay + 0.028 }
	if (kind === 'number')
		return (
			<motion.span
				className='grid place-items-center [grid-area:1/1]'
				initial={glyphFrom}
				animate={glyphRest}
				exit={exit}
				transition={pop}
			>
				{number}
			</motion.span>
		)
	return (
		<motion.svg
			className='grid size-3.5 place-items-center [grid-area:1/1]'
			viewBox='0 0 24 24'
			fill='none'
			stroke='currentColor'
			strokeWidth={2.5}
			strokeLinecap='round'
			strokeLinejoin='round'
			initial={glyphFrom}
			animate={glyphRest}
			exit={exit}
			transition={pop}
		>
			{kind === 'check' ? (
				<motion.path
					d='M5.5 12.5l4.25 4.25L18.5 8'
					initial={{ pathLength: 0 }}
					animate={{ pathLength: 1 }}
					transition={draw}
				/>
			) : (
				<>
					<motion.path
						d='M12 6.75v6.5'
						initial={{ pathLength: 0 }}
						animate={{ pathLength: 1 }}
						transition={draw}
					/>
					<motion.circle
						cx={12}
						cy={17.4}
						r={1.4}
						fill='currentColor'
						stroke='none'
						initial={{ scale: 0 }}
						animate={{ scale: 1 }}
						transition={reduced ? still : { ...spring.snappy, delay: delay + 0.112 }}
					/>
				</>
			)}
		</motion.svg>
	)
}
