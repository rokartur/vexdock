import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { cn } from 'cn'
import {
	AnimatePresence,
	type AnimationPlaybackControls,
	animate,
	motion,
	type Transition,
	useMotionValue,
	useReducedMotion,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

export interface SkeletonProps {
	label?: string
	lines?: number
	avatar?: boolean
	className?: string
	children?: ReactNode
	loading?: boolean
}

const { duration, ease, spring } = motionTokens
// Arc's finite 1.8s pulse (11 runs, about 20s) at 0.7x, each block a 90ms beat (63ms here) after the one above.
const pulse = { duration: 1.26, ease: [...ease.inOut], repeat: 10 } satisfies Transition
const PULSE_STAGGER = 0.063

export function Skeleton({
	label = 'Loading content',
	lines = 3,
	avatar = false,
	className,
	children,
	loading = true,
}: SkeletonProps) {
	const reduce = useReducedMotion()
	if (children === undefined) {
		return <Placeholder label={label} lines={lines} avatar={avatar} reduce={reduce} className={className} />
	}
	const exit = { opacity: 0, transition: { duration: reduce ? duration.instant : duration.fast } }
	return (
		<HeightFrame className={className} busy={loading} reduce={reduce}>
			<AnimatePresence mode='popLayout' initial={false}>
				{loading ? (
					<motion.div
						key='placeholder'
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={exit}
						transition={{
							duration: reduce ? duration.instant : duration.fast,
							ease: [...ease.standard],
						}}
					>
						<Placeholder label={label} lines={lines} avatar={avatar} reduce={reduce} />
					</motion.div>
				) : (
					<motion.div
						key='content'
						initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
						animate={{ opacity: 1, y: 0 }}
						exit={exit}
						transition={{
							duration: reduce ? duration.instant : duration.standard,
							ease: [...ease.enter],
						}}
					>
						{children}
					</motion.div>
				)}
			</AnimatePresence>
		</HeightFrame>
	)
}

function Placeholder({
	label,
	lines,
	avatar,
	reduce,
	className,
}: {
	label: string
	lines: number
	avatar: boolean
	reduce: boolean | null
	className?: string
}) {
	const count = Math.min(Math.max(Math.floor(lines), 1), 6)
	const block = 'block flex-none bg-[color-mix(in_oklab,var(--border-strong)_38%,var(--surface))]'
	const pulseAt = (order: number) =>
		reduce
			? {}
			: {
					animate: { opacity: [1, 0.52, 1] },
					transition: { ...pulse, delay: order * PULSE_STAGGER },
				}
	return (
		<div
			className={cn('flex w-full min-w-0 items-start gap-4', className)}
			role='status'
			aria-label={label}
			aria-busy='true'
		>
			{avatar && (
				<motion.span className={cn(block, 'size-control-md rounded-full')} aria-hidden='true' {...pulseAt(0)} />
			)}
			<span className='grid flex-1 gap-3 pt-1' aria-hidden='true'>
				{Array.from({ length: count }, (_, line) => (
					<motion.span
						key={line}
						className={cn(block, 'h-3 w-full rounded-control first:h-4 first:w-[48%] last:w-[72%]')}
						{...pulseAt(line + (avatar ? 1 : 0))}
					/>
				))}
			</span>
		</div>
	)
}

// Follows its content height. Right after `busy` flips, the height springs from the old size to the new one and
// returns to auto, so a later reflow (a resize, a font swap) follows instantly. It clips only while moving.
function HeightFrame({
	className,
	busy,
	reduce,
	children,
}: {
	className?: string
	busy: boolean
	reduce: boolean | null
	children: ReactNode
}) {
	const frame = useRef<HTMLDivElement>(null)
	const content = useRef<HTMLDivElement>(null)
	const height = useMotionValue<number | 'auto'>('auto')
	const changedAt = useRef(0)
	useLayoutEffect(() => {
		changedAt.current = performance.now()
	}, [busy])
	useEffect(() => {
		const node = content.current
		const frameNode = frame.current
		if (!node || !frameNode) return
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
			if (reduce || from === undefined || from === next || performance.now() - changedAt.current > 120) {
				settle()
				return
			}
			// Pin the old height before this frame paints, then spring to the new one.
			Object.assign(frameNode.style, { overflow: 'hidden', height: `${from}px` })
			controls = animate(height, [from, next], { ...spring.smooth, onComplete: settle })
		})
		observer.observe(node)
		return () => {
			observer.disconnect()
			controls?.stop()
		}
	}, [height, reduce])
	return (
		<motion.div ref={frame} className={className} aria-busy={busy} style={{ height }}>
			<div ref={content} className='relative flow-root'>
				{children}
			</div>
		</motion.div>
	)
}
