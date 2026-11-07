import { isValidElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Menu } from '@base-ui/react/menu'
import { IconChevronDown } from '@tabler/icons-react'
import { cn } from 'cn'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from 'motion/react'
import type { TargetAndTransition } from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type SplitButtonAction = {
	label: string
	onSelect?: () => void
	disabled?: boolean
	destructive?: boolean
	icon?: ReactNode
}

type SplitButtonProps = {
	label: string
	actions: SplitButtonAction[]
	onClick?: () => void
	disabled?: boolean
	// vexdock: busy like Button's `loading`: the icon turns into a spinner and the button stays at full strength.
	loading?: boolean
	icon?: ReactNode
	variant?: 'primary' | 'secondary'
	// vexdock: `sm` lets the primary sit in a section header beside its 36px controls; the secondary is always sm.
	size?: 'sm' | 'md'
}

const { blur, duration, ease, spring, stagger } = motionTokens

const rest: TargetAndTransition = { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }
const fadeIn: TargetAndTransition = { ...rest, opacity: 0 }
const fadeOut: TargetAndTransition = { opacity: 0, transition: { duration: duration.instant } }
const glyphIn: TargetAndTransition = { opacity: 0, y: 5, filter: `blur(${blur.soft}px)` }
const glyphOut: TargetAndTransition = {
	opacity: 0,
	y: -4,
	filter: `blur(${blur.subtle}px)`,
	transition: { duration: duration.fast, ease: [...ease.standard] },
}
const iconIn: TargetAndTransition = { opacity: 0, scale: 0.6, filter: `blur(${blur.subtle}px)` }
const iconOut: TargetAndTransition = {
	...iconIn,
	transition: { duration: duration.fast, ease: [...ease.standard] },
}
// Scale rides the spring; opacity and blur tween so blur never overshoots below zero.
const iconEnter = {
	...spring.snappy,
	opacity: { duration: duration.fast, ease: [...ease.enter] },
	filter: { duration: duration.fast, ease: [...ease.enter] },
}
// Arc caps the per-letter delay at 100ms; 70ms here at the 0.7x tempo.
const glyphDelayCap = 0.07

// Arc's modal Radix menu blocks pointer events, so the open trigger keeps its open color under the pointer.
const variants = {
	primary: {
		group: 'rounded-control border-foreground bg-foreground',
		half: 'bg-foreground text-background hover:not-data-popup-open:bg-[color-mix(in_oklab,var(--foreground)_88%,var(--background))] active:bg-[color-mix(in_oklab,var(--foreground)_80%,var(--background))] data-popup-open:bg-[color-mix(in_oklab,var(--foreground)_80%,var(--background))]',
		main: 'rounded-l-[calc(var(--radius-control)-1px)] px-3 text-sm',
		trigger:
			'w-8 rounded-r-[calc(var(--radius-control)-1px)] border-l-[color-mix(in_oklab,var(--background)_18%,var(--foreground))]',
	},
	secondary: {
		group: 'rounded-full border-border bg-surface',
		half: 'bg-surface text-foreground hover:not-data-popup-open:bg-surface-muted active:bg-[color-mix(in_oklab,var(--surface-muted),var(--border)_55%)] data-popup-open:bg-[color-mix(in_oklab,var(--surface-muted),var(--border)_55%)]',
		main: 'min-w-[142px] rounded-l-full px-2 text-xs',
		trigger: 'w-6.5 rounded-r-full border-l-border-subtle',
	},
}

// The main action morphs its icon and label in place while its width follows on a spring; the menu half never scales, so the menu opens from a still anchor.
export function SplitButton({
	label,
	actions,
	onClick,
	disabled,
	loading = false,
	icon: restingIcon,
	variant = 'primary',
	size = 'md',
}: SplitButtonProps) {
	const reduced = useReducedMotion() ?? false
	const contentRef = useRef<HTMLSpanElement>(null)
	const icon = loading ? (
		<span className='size-3.5 rounded-full border-[1.5px] border-current border-r-transparent [animation-duration:700ms] motion-safe:animate-spin' />
	) : (
		restingIcon
	)
	const glyph = iconKey(icon)
	const width = useMorphWidth(contentRef, `${glyph}|${label}`, reduced)
	const styles = variants[variant]
	// vexdock: the height left Arc's variant classes so `size` can pick it.
	const height = variant === 'secondary' || size === 'sm' ? 'min-h-control-sm' : 'min-h-control-md'

	return (
		<Menu.Root>
			<div
				className={cn(
					'inline-flex items-stretch border [transition:scale_400ms_var(--ease-spring)] has-[>:first-child:active:enabled]:[transition:scale_85ms_var(--ease-standard)] motion-safe:has-[>:first-child:active:enabled]:scale-97',
					styles.group,
				)}
			>
				<button
					type='button'
					onClick={loading ? undefined : onClick}
					disabled={disabled}
					aria-busy={loading || undefined}
					aria-disabled={loading || undefined}
					className={cn(
						'relative inline-grid place-items-center border-0 font-medium disabled:opacity-52',
						styles.half,
						height,
						styles.main,
					)}
				>
					<motion.span
						aria-hidden='true'
						style={{ width }}
						className='inline-flex min-w-0 items-center data-morphing:[clip-path:inset(-50%_calc(var(--spacing)*-1.5))]'
					>
						<span ref={contentRef} className='inline-flex flex-none items-center gap-1.5 whitespace-nowrap'>
							{icon ? (
								<span className='inline-grid flex-none place-items-center'>
									<AnimatePresence initial={false}>
										<motion.span
											key={glyph}
											initial={reduced ? fadeIn : iconIn}
											animate={rest}
											exit={reduced ? fadeOut : iconOut}
											transition={reduced ? { duration: duration.instant } : iconEnter}
											className='inline-flex items-center justify-center [grid-area:1/1]'
										>
											{icon}
										</motion.span>
									</AnimatePresence>
								</span>
							) : null}
							<MorphText text={label} reduced={reduced} />
						</span>
					</motion.span>
					<span className='sr-only' aria-live='polite'>
						{label}
					</span>
				</button>
				<Menu.Trigger
					aria-label={`${label} more actions`}
					disabled={disabled || loading}
					className={cn(
						'group/trigger grid place-items-center border-0 border-l disabled:opacity-52',
						styles.half,
						height,
						styles.trigger,
					)}
				>
					<IconChevronDown
						size={16}
						stroke={1.75}
						aria-hidden='true'
						className='[transition:rotate_400ms_var(--ease-spring)] group-data-popup-open/trigger:rotate-180'
					/>
				</Menu.Trigger>
			</div>
			<Menu.Portal>
				<Menu.Positioner sideOffset={4} align='end' collisionPadding={12} className='z-60'>
					<Menu.Popup className='max-w-(--available-width) min-w-[min(12rem,var(--available-width))] origin-(--transform-origin) rounded-panel border bg-surface-raised p-1 text-foreground shadow-floating [--menu-x:0px] [--menu-y:-5px] [transition:opacity_110ms_var(--ease-enter),translate_400ms_var(--ease-spring),scale_400ms_var(--ease-spring)] data-ending-style:pointer-events-none data-ending-style:[translate:calc(var(--menu-x)*0.5)_calc(var(--menu-y)*0.5)] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-ending-style:[transition:opacity_85ms_var(--ease-standard),translate_85ms_var(--ease-standard),scale_85ms_var(--ease-standard)] data-starting-style:[translate:var(--menu-x)_var(--menu-y)] data-starting-style:scale-97 data-starting-style:opacity-0 data-[side=left]:[--menu-x:5px] data-[side=left]:[--menu-y:0px] data-[side=right]:[--menu-x:-5px] data-[side=right]:[--menu-y:0px] data-[side=top]:[--menu-y:5px]'>
						{actions.map((action, index) => (
							<Menu.Item
								key={action.label}
								disabled={action.disabled}
								onClick={action.onSelect}
								style={{ transitionDelay: `${Math.min(index, 4) * stagger.item}s` }}
								className={cn(
									'flex min-h-control-sm items-center gap-2.5 rounded-[calc(var(--radius-panel)-6px)] px-2.5 text-sm [transition:opacity_170ms_var(--ease-enter),translate_170ms_var(--ease-enter)] in-data-starting-style:[translate:calc(var(--menu-x)*0.4)_calc(var(--menu-y)*0.4)] in-data-starting-style:opacity-0 data-disabled:opacity-45',
									action.destructive
										? 'text-danger data-highlighted:bg-[color-mix(in_oklab,var(--danger)_8%,var(--surface))]'
										: 'data-highlighted:bg-surface-muted',
								)}
							>
								{action.icon ? (
									<span aria-hidden='true' className='inline-flex'>
										{action.icon}
									</span>
								) : null}
								{action.label}
							</Menu.Item>
						))}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	)
}

// Names the icon element, so swapping Send for Check morphs while a re-render of the same icon stays still.
// Tabler icons are forwardRef objects, so only their displayName tells them apart.
function iconKey(node: ReactNode): string {
	if (!isValidElement(node)) return node == null || typeof node === 'boolean' ? '' : String(node)
	const { type } = node
	if (typeof type === 'string') return type
	const name = 'displayName' in type ? type.displayName : type.name
	return typeof name === 'string' ? name : 'icon'
}

// Springs the slot to the natural width of its content when the label changes; other resizes (a late web font) jump.
function useMorphWidth(content: RefObject<HTMLElement | null>, key: string, reduced: boolean) {
	const width = useMotionValue<number | 'auto'>('auto')
	const lastKey = useRef(key)
	const armedUntil = useRef(0)

	useLayoutEffect(() => {
		if (lastKey.current === key) return
		lastKey.current = key
		armedUntil.current = performance.now() + 700
	}, [key])

	useEffect(() => {
		const node = content.current
		const slot = node?.parentElement
		if (!node || !slot) return
		let measured = false
		const observer = new ResizeObserver(([entry]) => {
			const next = entry!.contentRect.width
			if (!next || !measured || reduced || performance.now() > armedUntil.current) {
				measured = next > 0
				width.jump(next || 'auto')
				delete slot.dataset.morphing
				return
			}
			slot.dataset.morphing = ''
			animate(width, next, {
				...spring.morph,
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

type Glyph = { id: string; char: string; order: number }

function toGlyphs(chars: string[], seq: number): Glyph[] {
	return chars.map((char, order) => ({ id: `${seq}:${order}`, char, order }))
}

// Shared leading and trailing characters keep their identity, so "Publish" to "Published" only adds the new letters.
function useGlyphs(text: string) {
	const [state, setState] = useState(() => ({ text, seq: 0, glyphs: toGlyphs([...text], 0) }))
	if (state.text === text) return state.glyphs

	const prev = [...state.text]
	const next = [...text]
	let start = 0
	let end = 0
	while (start < prev.length && start < next.length && prev[start] === next[start]) start++
	while (
		end < prev.length - start &&
		end < next.length - start &&
		prev[prev.length - 1 - end] === next[next.length - 1 - end]
	)
		end++
	if (start < 2) start = 0
	if (end < 2) end = 0

	const seq = state.seq + 1
	const glyphs = [
		...state.glyphs.slice(0, start),
		...toGlyphs(next.slice(start, next.length - end), seq),
		...state.glyphs.slice(state.glyphs.length - end),
	]
	setState({ text, seq, glyphs })
	return glyphs
}

function MorphText({ text, reduced }: { text: string; reduced: boolean }) {
	const glyphs = useGlyphs(text)
	return (
		<span className='relative inline-flex flex-none whitespace-pre'>
			<AnimatePresence mode='popLayout' initial={false}>
				{glyphs.map(glyph => (
					<motion.span
						key={glyph.id}
						layout={reduced ? false : 'position'}
						layoutDependency={text}
						initial={reduced ? fadeIn : glyphIn}
						animate={rest}
						exit={reduced ? fadeOut : glyphOut}
						transition={
							reduced
								? { duration: duration.instant }
								: {
										duration: duration.standard,
										ease: [...ease.enter],
										delay: Math.min(glyph.order * stagger.char, glyphDelayCap),
										layout: spring.morph,
									}
						}
						className='inline-block'
					>
						{glyph.char}
					</motion.span>
				))}
			</AnimatePresence>
		</span>
	)
}
