import { type HTMLAttributes, isValidElement, type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { cn } from 'cn'
import {
	AnimatePresence,
	type AnimationPlaybackControls,
	animate,
	type HTMLMotionProps,
	motion,
	type TargetAndTransition,
	type Transition,
	useIsPresent,
	useMotionValue,
	useReducedMotion,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

const tones = {
	neutral: '[--badge-color:var(--text-secondary)] border-border bg-surface-muted text-secondary',
	success:
		'[--badge-color:var(--success)] border-[color-mix(in_oklab,var(--success)_25%,var(--border))] bg-[color-mix(in_oklab,var(--success)_10%,var(--surface))] text-success',
	info: '[--badge-color:var(--accent)] border-[color-mix(in_oklab,var(--accent)_24%,var(--border))] bg-accent-subtle text-accent-strong',
	warning:
		'[--badge-color:var(--warning)] border-[color-mix(in_oklab,var(--warning)_27%,var(--border))] bg-[color-mix(in_oklab,var(--warning)_11%,var(--surface))] text-warning',
	danger: '[--badge-color:var(--danger)] border-[color-mix(in_oklab,var(--danger)_26%,var(--border))] bg-[color-mix(in_oklab,var(--danger)_10%,var(--surface))] text-danger',
} satisfies Record<string, string>

const sizes = {
	sm: 'min-h-5.5 px-2 text-[11px]/none',
	md: 'min-h-6.5 px-2.5 text-xs/none',
} satisfies Record<string, string>

export type BadgeTone = keyof typeof tones
export type BadgeSize = keyof typeof sizes

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
	tone?: BadgeTone
	size?: BadgeSize
	icon?: ReactNode
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
const fadeOnly: TargetAndTransition = { opacity: 0, transition: { duration: duration.instant } }

export function Badge({ tone = 'neutral', size = 'md', icon, className, children, ...props }: BadgeProps) {
	const reduce = useReducedMotion()
	const text = typeof children === 'string' || typeof children === 'number' ? String(children) : null
	const glyphKey = icon ? iconKey(icon) : ''
	const body = useRef<HTMLSpanElement>(null)
	const content = useRef<HTMLSpanElement>(null)
	// Width stays auto at rest; only a new label or icon springs it, passive reflows (a font swap) follow instantly.
	const width = useMotionValue<number | 'auto'>('auto')
	const changedAt = useRef(0)
	useLayoutEffect(() => {
		changedAt.current = performance.now()
	}, [text, glyphKey])
	useEffect(() => {
		const node = content.current
		if (!node) return
		let last: number | undefined
		let controls: AnimationPlaybackControls | undefined
		const settle = () => {
			width.jump('auto')
			if (body.current) body.current.style.width = 'auto'
		}
		const observer = new ResizeObserver(([entry]) => {
			const next = entry!.borderBoxSize[0]!.inlineSize
			const current = width.get()
			const from = typeof current === 'number' ? current : last
			last = next
			controls?.stop()
			if (reduce || from === undefined || from === next || performance.now() - changedAt.current > 120) {
				settle()
				return
			}
			// Pin the old width before this frame paints, then spring to the new one.
			if (body.current) body.current.style.width = `${from}px`
			controls = animate(width, [from, next], { ...spring.morph, onComplete: settle })
		})
		observer.observe(node)
		return () => {
			observer.disconnect()
			controls?.stop()
		}
	}, [width, reduce])
	const enter: Transition = reduce
		? { duration: duration.instant }
		: { duration: duration.standard, ease: [...ease.enter] }

	return (
		<span
			{...props}
			className={cn(
				'inline-flex items-center overflow-clip rounded-full border font-medium tracking-[-0.01em] whitespace-nowrap transition-[border-color,background-color,color] duration-170 ease-standard hover:border-[color-mix(in_oklab,var(--badge-color)_32%,var(--border))] hover:bg-[color-mix(in_oklab,var(--badge-color)_10%,var(--surface))]',
				tones[tone],
				sizes[size],
				className,
			)}
		>
			<motion.span ref={body} className='block' style={{ width }}>
				<span
					ref={content}
					className={cn('relative inline-flex w-max items-center gap-1.25', size === 'sm' && 'gap-1')}
				>
					{icon ? (
						<span
							className='relative inline-flex flex-none items-center justify-center leading-none text-(--badge-color)'
							aria-hidden='true'
						>
							<AnimatePresence mode='popLayout' initial={false}>
								<Swap
									key={glyphKey}
									className='relative inline-flex items-center'
									initial={reduce ? { opacity: 0 } : iconIn}
									animate={shown}
									exit={reduce ? fadeOnly : { ...iconIn, transition: exitFast }}
									transition={reduce ? enter : spring.snappy}
								>
									{icon}
								</Swap>
							</AnimatePresence>
						</span>
					) : null}
					{text === null ? (
						children
					) : (
						<span className='relative inline-flex items-center'>
							<AnimatePresence mode='popLayout' initial={false}>
								<Swap
									key={text}
									className='block'
									initial={reduce ? { opacity: 0 } : textIn}
									animate={shown}
									exit={reduce ? fadeOnly : textOut}
									transition={enter}
								>
									{text}
								</Swap>
							</AnimatePresence>
						</span>
					)}
				</span>
			</motion.span>
		</span>
	)
}

// Outgoing copies are hidden from assistive tech while they fade, so only the current text is read.
function Swap(props: HTMLMotionProps<'span'>) {
	const present = useIsPresent()
	return <motion.span {...props} aria-hidden={present ? props['aria-hidden'] : true} />
}

// A new icon component crossfades in; re-rendering the same icon stays still.
function iconKey(icon: ReactNode): string {
	if (!isValidElement(icon)) return 'icon'
	// unknown, not React's element type: a forwardRef icon's type is an object at runtime.
	const type: unknown = icon.type
	if (typeof type === 'string') return type
	if (typeof type !== 'function' && (typeof type !== 'object' || type === null)) return 'icon'
	const displayName = 'displayName' in type ? type.displayName : undefined
	if (typeof displayName === 'string') return displayName
	if ('name' in type && typeof type.name === 'string') return type.name
	return 'icon'
}
