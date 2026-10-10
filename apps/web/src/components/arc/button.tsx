'use client'

import { forwardRef, isValidElement, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { ButtonHTMLAttributes, ReactElement, ReactNode, Ref, RefObject } from 'react'
import { useRender } from '@base-ui/react/use-render'
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, useReducedMotion } from 'motion/react'
import type { TargetAndTransition, Variants } from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

// `not-disabled:` rather than `enabled:` so a rendered link, which has no :enabled state, still answers hover and press.
// A disabled outlined button keeps its shape and fades only its label, so it still reads as a button that is off.
const variants = {
	primary:
		'border-foreground bg-foreground text-background not-disabled:hover:opacity-91 not-disabled:hover:shadow-(--shadow-resting) not-disabled:active:opacity-84',
	secondary:
		'border-border bg-(--surface) text-foreground not-disabled:hover:bg-(--surface-muted) not-disabled:hover:shadow-(--shadow-resting) not-disabled:active:bg-(--surface-muted) disabled:bg-(--surface-muted) disabled:text-(--text-muted) disabled:opacity-100',
	ghost: 'border-transparent bg-transparent text-(--text-secondary) not-disabled:hover:bg-(--surface-muted) not-disabled:hover:text-foreground not-disabled:active:bg-(--surface-muted) not-disabled:active:text-foreground disabled:text-(--text-muted) disabled:opacity-100',
	danger: 'border-border bg-(--surface) text-(--danger) not-disabled:hover:border-(--danger) not-disabled:hover:bg-(--surface-muted) not-disabled:active:border-(--danger) not-disabled:active:bg-(--surface-muted) disabled:bg-(--surface-muted) disabled:text-[color-mix(in_oklab,var(--danger)_55%,var(--surface-muted))] disabled:opacity-100',
} satisfies Record<ButtonVariant, string>

export interface ButtonProps extends Omit<
	ButtonHTMLAttributes<HTMLButtonElement>,
	'onDrag' | 'onDragEnd' | 'onDragStart' | 'onAnimationStart'
> {
	variant?: ButtonVariant
	size?: ButtonSize
	loading?: boolean
	/** Square, for a lone icon. */
	icon?: boolean
	/** Renders this element (a router link) styled as the button instead of a <button>; no press or label motion. */
	render?: ReactElement
}

/** Icon buttons press a little deeper, wide buttons a little less, so every size reads as the same push. */
const pressVariants: Variants = {
	pressed: (button: RefObject<HTMLButtonElement | null>) => {
		const width = button.current?.offsetWidth ?? 0
		return {
			scale: width > 220 ? 0.985 : width && width <= 48 ? 0.96 : 0.97,
			transition: { duration: motionTokens.duration.instant, ease: [...motionTokens.ease.standard] },
		}
	},
}

const rest: TargetAndTransition = { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }
/** Text rises about .3em out of a soft blur; the outgoing label lifts away a little faster. */
const textIn: TargetAndTransition = { opacity: 0, y: 4, filter: `blur(${motionTokens.blur.soft}px)` }
const textOut: TargetAndTransition = {
	opacity: 0,
	y: -3,
	filter: `blur(${motionTokens.blur.soft}px)`,
	transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] },
}
const iconIn: TargetAndTransition = { opacity: 0, scale: 0.6, filter: `blur(${motionTokens.blur.subtle}px)` }
const iconOut: TargetAndTransition = {
	opacity: 0,
	scale: 0.6,
	filter: `blur(${motionTokens.blur.subtle}px)`,
	transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] },
}
const fadeIn: TargetAndTransition = { ...rest, opacity: 0 }
const fadeOut: TargetAndTransition = { opacity: 0, transition: { duration: motionTokens.duration.instant } }
/** Scale rides the spring; opacity and blur tween so blur never overshoots below zero. */
const iconEnter = {
	...motionTokens.spring.snappy,
	opacity: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.enter] },
	filter: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.enter] },
} as const

/** A key for the label content: text plus element names, so a new label or icon crossfades while prop-only updates stay in place. */
function labelKey(node: ReactNode): string {
	if (node == null || typeof node === 'boolean') return ''
	if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') return String(node)
	if (Array.isArray(node)) return node.map(labelKey).join('')
	if (!isValidElement(node)) return ''
	const type = node.type as string | { displayName?: string; name?: string }
	return `<${typeof type === 'string' ? type : (type?.displayName ?? type?.name ?? '')}>${labelKey((node.props as { children?: ReactNode }).children)}`
}

/** Springs the slot to the natural width of the incoming label when it changes, so a new label never snaps the button's size.
 *  The outgoing label is popped out of flow at once, so it never holds the old width. Other resizes (a late web font, a parent reflow) jump straight to the new width, so nothing wobbles on first paint. */
function useMorphWidth(content: RefObject<HTMLElement | null>, key: string, reduced: boolean) {
	const width = useMotionValue<number | 'auto'>('auto')
	const lastKey = useRef(key),
		armedUntil = useRef(0)
	useLayoutEffect(() => {
		if (lastKey.current === key) return
		lastKey.current = key
		armedUntil.current = performance.now() + 700
	}, [key])
	useEffect(() => {
		const node = content.current,
			slot = node?.parentElement
		if (!node || !slot || typeof ResizeObserver === 'undefined') return
		let measured = false
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return
			const next = entry.contentRect.width
			if (!next || !measured || reduced || performance.now() > armedUntil.current) {
				measured = next > 0
				width.jump(next || 'auto')
				delete slot.dataset.morphing
				return
			}
			slot.dataset.morphing = ''
			animate(width, next, {
				...motionTokens.spring.morph,
				onComplete: () => {
					delete slot.dataset.morphing
				},
			})
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [content, reduced, width])
	return width
}

function LabelPhase({
	children,
	icon,
	reduced,
	ref,
}: {
	children: ReactNode
	icon: boolean
	reduced: boolean
	ref?: Ref<HTMLSpanElement>
}) {
	const present = useIsPresent()
	return (
		<motion.span
			ref={ref}
			className='inline-flex items-center justify-center gap-(--space-2) whitespace-nowrap'
			aria-hidden={present ? undefined : true}
			initial={reduced ? fadeIn : icon ? iconIn : textIn}
			animate={rest}
			exit={reduced ? fadeOut : icon ? iconOut : textOut}
			transition={
				reduced
					? { duration: motionTokens.duration.instant }
					: icon
						? iconEnter
						: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }
			}
		>
			{children}
		</motion.span>
	)
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{
		className,
		variant = 'primary',
		size = 'md',
		loading = false,
		icon = false,
		render,
		disabled,
		children,
		onClick,
		...props
	},
	ref,
) {
	const reduceMotion = useReducedMotion() ?? false
	const buttonRef = useRef<HTMLButtonElement | null>(null)
	const contentRef = useRef<HTMLSpanElement>(null)
	const key = labelKey(children)
	const width = useMorphWidth(contentRef, key, reduceMotion)
	const setRefs = useCallback(
		(node: HTMLButtonElement | null) => {
			buttonRef.current = node
			if (typeof ref === 'function') ref(node)
			else if (ref) ref.current = node
		},
		[ref],
	)
	// A trigger that anchors a menu, popover, or dialog keeps its rect still while pressed, so the layer never measures a scaled anchor.
	// Base UI triggers rendered as this button pass aria-haspopup through.
	const popup = props['aria-haspopup']
	const anchorsLayer = (popup !== undefined && popup !== false && popup !== 'false') || props.role === 'combobox'
	const inert = disabled || loading || props['aria-disabled'] === true || props['aria-disabled'] === 'true'
	// A pressed toggle (follow, wrap) reads as its hover state kept on. Tabler icons ship at 24px; a control icon sits at 16.
	const classes = cn(
		'relative inline-flex min-h-(--control-height-md) cursor-pointer items-center justify-center gap-1.5 rounded-(--radius-control) border border-transparent px-2.5 text-sm/(--leading-body) font-medium whitespace-nowrap no-underline transition-[color,background,border-color,opacity,box-shadow] duration-(--duration-fast) ease-(--ease-standard) [-webkit-tap-highlight-color:transparent] disabled:cursor-not-allowed disabled:opacity-52 aria-busy:cursor-progress aria-pressed:bg-(--surface-muted) aria-pressed:text-foreground motion-reduce:transition-none [&_svg]:size-4 [&_svg]:flex-none',
		variants[variant],
		size === 'sm' && 'min-h-(--control-height-sm)',
		icon && 'aspect-square px-0',
		className,
	)

	const rendered = useRender({
		render,
		ref,
		props: { ...props, className: classes, onClick, children },
		enabled: render !== undefined,
	})
	if (rendered) return rendered

	return (
		<motion.button
			ref={setRefs}
			tabIndex={props.tabIndex ?? 0}
			className={classes}
			disabled={disabled}
			aria-busy={loading || undefined}
			custom={buttonRef}
			variants={pressVariants}
			whileTap={reduceMotion || anchorsLayer || inert ? undefined : 'pressed'}
			transition={motionTokens.spring.snappy}
			{...props}
			// Loading keeps the button focusable (a disabled button would drop keyboard focus mid-action) and swallows presses instead.
			aria-disabled={loading || props['aria-disabled'] || undefined}
			onClick={loading ? event => event.preventDefault() : onClick}
		>
			<AnimatePresence initial={false}>
				{loading ? (
					<motion.span
						key='loader'
						className='absolute top-1/2 left-1/2 m-[calc(var(--space-4)/-2)] grid size-(--space-4)'
						aria-hidden='true'
						initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
						animate={{ opacity: 1, scale: 1 }}
						exit={reduceMotion ? fadeOut : { ...iconOut, scale: 0.8 }}
						transition={reduceMotion ? { duration: motionTokens.duration.instant } : iconEnter}
					>
						<span className='animate-spin rounded-full border-[1.5px] border-current border-r-transparent [animation-duration:0.7s] motion-reduce:animate-none' />
					</motion.span>
				) : null}
			</AnimatePresence>
			<motion.span
				// The slot's width follows the incoming label on a spring; while it catches up the label may overflow evenly, so the clip widens.
				className={cn(
					'relative inline-flex min-w-0 items-center justify-center transition-opacity duration-(--duration-fast) ease-(--ease-standard) data-morphing:[clip-path:inset(-50%_calc(var(--space-3)*-1))] motion-reduce:duration-(--duration-instant)',
					loading && 'opacity-0',
				)}
				style={{ width }}
			>
				<span ref={contentRef} className='inline-flex flex-none items-center'>
					<AnimatePresence mode='popLayout' initial={false}>
						<LabelPhase key={key} icon={!/\S/.test(key.replace(/<[^>]*>/g, ''))} reduced={reduceMotion}>
							{children}
						</LabelPhase>
					</AnimatePresence>
				</span>
			</motion.span>
		</motion.button>
	)
})

Button.displayName = 'Button'

export default Button
