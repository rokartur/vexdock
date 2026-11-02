import { isValidElement, type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { IconFolder } from '@tabler/icons-react'
import { cn } from 'cn'
import {
	AnimatePresence,
	animate,
	motion,
	type AnimationPlaybackControls,
	type HTMLMotionProps,
	type MotionProps,
	type TargetAndTransition,
	type Transition,
	useIsPresent,
	useMotionValue,
	useReducedMotion,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

type EmptyStateProps = {
	title: string
	// vexdock: optional, a list's empty state often needs only the title.
	description?: string
	action?: ReactNode
	icon?: ReactNode
	// vexdock: a scene from ui/empty-states.tsx in place of the icon tile, for a page-sized empty state.
	illustration?: ReactNode
	className?: string
	label?: string
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

export function EmptyState({ title, description, action, icon, illustration, className, label }: EmptyStateProps) {
	const reduce = useReducedMotion()
	const glyph = icon ?? <IconFolder size={24} stroke={1.5} />
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
		<section
			aria-label={label}
			className={cn(
				'flex w-full flex-col items-center px-4 py-[clamp(--spacing(6),8vw,--spacing(10))] text-center',
				className,
			)}
		>
			{illustration ?? (
				<div
					aria-hidden='true'
					className='relative grid size-12 place-items-center rounded-panel border bg-surface-muted text-secondary transition-[opacity,scale] duration-340 ease-enter starting:scale-92 starting:opacity-0'
				>
					<AnimatePresence mode='popLayout' initial={false}>
						<Swap
							key={iconKey(glyph)}
							className='grid place-items-center'
							initial={reduce ? { opacity: 0 } : iconIn}
							animate={shown}
							exit={reduce ? fadeOut : { ...iconIn, transition: exitFast }}
							transition={reduce ? enter : spring.snappy}
						>
							{glyph}
						</Swap>
					</AnimatePresence>
				</div>
			)}
			<HeightFrame reduce={reduce} morphKey={`${title}\n${description}`}>
				<h3 className='relative mt-4 font-display text-base leading-[1.1] font-medium tracking-[-0.03em] text-foreground'>
					<AnimatePresence mode='popLayout' initial={false}>
						<Swap key={title} className='block text-balance' {...swap}>
							{title}
						</Swap>
					</AnimatePresence>
				</h3>
				{description && (
					<p className='relative mx-auto mt-1.5 max-w-[18rem] text-sm text-secondary'>
						<AnimatePresence mode='popLayout' initial={false}>
							<Swap key={description} className='block text-balance' {...swap}>
								{description}
							</Swap>
						</AnimatePresence>
					</p>
				)}
			</HeightFrame>
			{action && <div className='mt-4 flex flex-wrap justify-center gap-2.5'>{action}</div>}
		</section>
	)
}

// Outgoing copies are hidden from assistive tech while they fade.
function Swap(props: HTMLMotionProps<'span'>) {
	const present = useIsPresent()
	return <motion.span {...props} aria-hidden={present ? props['aria-hidden'] : true} />
}

// Keyed by component, so a new icon crossfades in and re-rendering the same icon stays still.
function iconKey(icon: ReactNode) {
	if (!isValidElement(icon)) return 'icon'
	const { type } = icon
	if (typeof type === 'string') return type
	const name = 'displayName' in type ? type.displayName : type.name
	return typeof name === 'string' && name ? name : 'icon'
}

// After `morphKey` changes the height springs from the old size to the new one, then returns to auto,
// so passive reflows follow instantly; it clips only while moving, so focus rings stay visible at rest.
function HeightFrame({
	reduce,
	morphKey,
	children,
}: {
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
		const frameNode = frame.current!
		const contentNode = content.current!
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
		observer.observe(contentNode)
		return () => {
			observer.disconnect()
			controls?.stop()
		}
	}, [height, reduce])

	return (
		<motion.div ref={frame} className='w-full max-w-full' style={{ height }}>
			<div ref={content} className='flow-root'>
				{children}
			</div>
		</motion.div>
	)
}
