import {
	type ComponentProps,
	isValidElement,
	type MouseEvent,
	type ReactElement,
	type ReactNode,
	type Ref,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
} from 'react'
import { Button as BaseButton } from '@base-ui/react/button'
import { useRender } from '@base-ui/react/use-render'
import { cn } from 'cn'
import {
	AnimatePresence,
	animate,
	motion,
	type TargetAndTransition,
	type Transition,
	type Variants,
	useIsPresent,
	useMotionValue,
	useReducedMotion,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

// vexdock: `data-held:` repeats each `active:` for a button that opens a DropdownMenu, whose backdrop clears :active.
const variants = {
	primary:
		'border-foreground bg-foreground text-background hover:opacity-91 hover:shadow-resting active:opacity-84 data-held:opacity-84 disabled:opacity-52',
	secondary:
		'border-border bg-surface text-foreground hover:bg-surface-muted hover:shadow-resting active:bg-surface-pressed data-held:bg-surface-pressed disabled:bg-surface-muted disabled:text-muted',
	ghost: 'border-transparent text-secondary hover:bg-surface-muted hover:text-foreground active:bg-surface-pressed active:text-foreground data-held:bg-surface-pressed data-held:text-foreground disabled:text-muted',
	danger: 'border-border bg-surface text-danger hover:border-danger hover:bg-surface-muted active:border-danger active:bg-surface-pressed data-held:border-danger data-held:bg-surface-pressed disabled:bg-surface-muted disabled:text-[color-mix(in_oklab,var(--danger)_55%,var(--surface-muted))]',
} satisfies Record<string, string>

// vexdock: a link has no :disabled to match, so the render path's inert look repeats each variant's disabled: classes.
const inertLink = {
	primary: 'opacity-52',
	secondary: 'bg-surface-muted text-muted',
	ghost: 'text-muted',
	danger: 'bg-surface-muted text-[color-mix(in_oklab,var(--danger)_55%,var(--surface-muted))]',
} satisfies Record<keyof typeof variants, string>

const sizes = {
	sm: 'min-h-control-sm px-2.5',
	md: 'min-h-control-md px-3',
	lg: 'min-h-control-lg px-4',
} satisfies Record<string, string>

// The drag and animation handlers would reach motion.button as gestures, so they are not forwarded.
export type ButtonProps = Omit<
	ComponentProps<'button'>,
	'onDrag' | 'onDragEnd' | 'onDragStart' | 'onAnimationStart'
> & {
	variant?: keyof typeof variants
	size?: keyof typeof sizes
	loading?: boolean
	// vexdock: square, for a lone icon.
	icon?: boolean
	// vexdock: renders this element (a router link) styled as the button.
	render?: ReactElement
}

const { blur, duration, ease, spring } = motionTokens
// Icon buttons press a little deeper, wide buttons a little less, so every size reads as the same push.
const pressVariants: Variants = {
	pressed: (button: RefObject<HTMLButtonElement | null>) => {
		const width = button.current?.offsetWidth ?? 0
		return {
			scale: width > 220 ? 0.985 : width && width <= 48 ? 0.96 : 0.97,
			transition: { duration: duration.instant, ease: [...ease.standard] },
		}
	},
}
const rest: TargetAndTransition = { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }
const textIn: TargetAndTransition = { opacity: 0, y: 4, filter: `blur(${blur.soft}px)` }
const textOut: TargetAndTransition = {
	opacity: 0,
	y: -3,
	filter: `blur(${blur.soft}px)`,
	transition: { duration: duration.fast, ease: [...ease.standard] },
}
const iconIn: TargetAndTransition = { opacity: 0, scale: 0.6, filter: `blur(${blur.subtle}px)` }
const iconOut: TargetAndTransition = {
	opacity: 0,
	scale: 0.6,
	filter: `blur(${blur.subtle}px)`,
	transition: { duration: duration.fast, ease: [...ease.standard] },
}
const fadeOut: TargetAndTransition = { opacity: 0, transition: { duration: duration.instant } }
const fadeEnter: Transition = { duration: duration.instant }
// Scale rides the spring; opacity and blur tween so blur never overshoots below zero.
const iconEnter: Transition = {
	...spring.snappy,
	opacity: { duration: duration.fast, ease: [...ease.enter] },
	filter: { duration: duration.fast, ease: [...ease.enter] },
}

type Phase = { initial: TargetAndTransition; exit: TargetAndTransition; transition: Transition }
const textPhase: Phase = {
	initial: textIn,
	exit: textOut,
	transition: { duration: duration.standard, ease: [...ease.enter] },
}
const iconPhase: Phase = { initial: iconIn, exit: iconOut, transition: iconEnter }
const fadePhase: Phase = { initial: { ...rest, opacity: 0 }, exit: fadeOut, transition: fadeEnter }

export function Button({
	variant = 'primary',
	size = 'md',
	loading = false,
	icon = false,
	render,
	className,
	children,
	onClick,
	...props
}: ButtonProps) {
	const reduceMotion = useReducedMotion() ?? false
	const buttonRef = useRef<HTMLButtonElement>(null)
	const contentRef = useRef<HTMLSpanElement>(null)
	const key = labelKey(children)
	let phase = /\S/.test(key.replace(/<[^>]*>/g, '')) ? textPhase : iconPhase
	if (reduceMotion) phase = fadePhase

	// A popup, menu or dialog trigger keeps its rect still while pressed, so the layer never measures a scaled anchor.
	const popup = props['aria-haspopup']
	const anchorsLayer =
		(popup !== undefined && popup !== false && popup !== 'false') ||
		props.role === 'combobox' ||
		props['aria-expanded'] !== undefined
	const inert = props.disabled || loading || props['aria-disabled'] === true || props['aria-disabled'] === 'true'

	// The slot springs to a new label's width only within 700ms of the label changing; a late font or reflow jumps.
	const width = useMotionValue<number | 'auto'>('auto')
	const lastKey = useRef(key)
	const armedUntil = useRef(0)
	useLayoutEffect(() => {
		if (lastKey.current === key) return
		lastKey.current = key
		armedUntil.current = performance.now() + 700
	}, [key])
	useEffect(() => {
		const content = contentRef.current
		const slot = content?.parentElement
		if (!content || !slot) return
		let measured = false
		const observer = new ResizeObserver(([entry]) => {
			const next = entry!.contentRect.width
			if (!next || !measured || reduceMotion || performance.now() > armedUntil.current) {
				measured = next > 0
				width.jump(next || 'auto')
				delete slot.dataset.morphing
				return
			}
			slot.dataset.morphing = ''
			animate(width, next, {
				...spring.morph,
				onComplete: () => delete slot.dataset.morphing,
			})
		})
		observer.observe(content)
		return () => observer.disconnect()
	}, [reduceMotion, width])

	const classes = cn(
		'relative inline-flex items-center justify-center gap-1.5 rounded-control border text-sm font-medium whitespace-nowrap',
		variants[variant],
		sizes[size],
		icon && 'aspect-square px-0',
		className,
	)

	// vexdock: a link styled as the button stays a link, where Base UI's Button would give it role="button". It has no
	// motion.button to press, so it takes the CSS press; inert, it keeps focus and stops navigating, as loading does below.
	const link = useRender({
		render,
		enabled: render !== undefined,
		props: {
			...props,
			type: undefined,
			disabled: undefined,
			'aria-disabled': inert || undefined,
			'aria-busy': loading || undefined,
			// The hover and active variants (styles.css) skip [data-disabled], so an inert link takes no fill.
			'data-disabled': inert ? '' : undefined,
			onClick: inert ? (event: MouseEvent) => event.preventDefault() : onClick,
			className: cn(classes, inert ? inertLink[variant] : 'press'),
			children,
		},
	})
	if (link) return link

	return (
		<BaseButton
			tabIndex={0}
			render={
				<motion.button
					ref={buttonRef}
					custom={buttonRef}
					variants={pressVariants}
					whileTap={reduceMotion || anchorsLayer || inert ? undefined : 'pressed'}
					transition={spring.snappy}
				/>
			}
			className={classes}
			{...props}
			aria-busy={loading || undefined}
			// Loading keeps the button focusable, so keyboard focus survives the action, and swallows presses instead.
			aria-disabled={loading || props['aria-disabled'] || undefined}
			onClick={loading ? event => event.preventDefault() : onClick}
		>
			<AnimatePresence initial={false}>
				{loading && (
					<motion.span
						key='loader'
						aria-hidden
						className='absolute top-1/2 left-1/2 -m-1.5 grid size-3'
						initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
						animate={{ opacity: 1, scale: 1 }}
						exit={reduceMotion ? fadeOut : { ...iconOut, scale: 0.8 }}
						transition={reduceMotion ? fadeEnter : iconEnter}
					>
						<span className='animate-spin rounded-full border-[1.5px] border-current border-r-transparent [animation-duration:700ms]' />
					</motion.span>
				)}
			</AnimatePresence>
			<motion.span
				style={{ width }}
				className={cn(
					'relative inline-flex min-w-0 items-center justify-center transition-opacity data-morphing:[clip-path:inset(-50%_-0.625rem)]',
					loading && 'opacity-0',
				)}
			>
				<span ref={contentRef} className='inline-flex flex-none items-center'>
					<AnimatePresence mode='popLayout' initial={false}>
						<LabelPhase key={key} phase={phase}>
							{children}
						</LabelPhase>
					</AnimatePresence>
				</span>
			</motion.span>
		</BaseButton>
	)
}

function LabelPhase({ children, phase, ref }: { children: ReactNode; phase: Phase; ref?: Ref<HTMLSpanElement> }) {
	const present = useIsPresent()
	return (
		<motion.span
			ref={ref}
			aria-hidden={present ? undefined : true}
			className='inline-flex items-center justify-center gap-1.5 whitespace-nowrap [&_svg]:flex-none'
			initial={phase.initial}
			animate={rest}
			exit={phase.exit}
			transition={phase.transition}
		>
			{children}
		</motion.span>
	)
}

// Text plus element names, so a new label or icon crossfades while prop-only updates stay in place.
function labelKey(node: ReactNode): string {
	if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') {
		return String(node)
	}
	if (Array.isArray(node)) return node.map(labelKey).join('')
	if (!isValidElement<{ children?: ReactNode }>(node)) return ''
	return `<${elementName(node.type)}>${labelKey(node.props.children)}`
}

// unknown, not React's element type: a Fragment's type is a symbol at runtime.
function elementName(type: unknown): string {
	if (typeof type === 'string') return type
	if (typeof type !== 'function' && (typeof type !== 'object' || type === null)) return ''
	const displayName = 'displayName' in type ? type.displayName : undefined
	if (typeof displayName === 'string') return displayName
	if ('name' in type && typeof type.name === 'string') return type.name
	return ''
}
