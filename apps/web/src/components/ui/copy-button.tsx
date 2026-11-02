import { useEffect, useRef, useState } from 'react'
import { IconAlertCircle, IconCopy } from '@tabler/icons-react'
import { cn } from 'cn'
import {
	AnimatePresence,
	LayoutGroup,
	motion,
	type TargetAndTransition,
	type Transition,
	useReducedMotion,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

type CopyButtonProps = {
	value: string
	label?: string
	iconOnly?: boolean
	variant?: 'outline' | 'plain'
	disabled?: boolean
	onCopied?: () => void
	// vexdock: the clipboard API needs HTTPS, so a page served over plain HTTP explains the fallback.
	onError?: () => void
	className?: string
}

type CopyState = 'idle' | 'copied' | 'error'

const variants = {
	outline: 'border-border bg-surface text-foreground hover:border-border-strong hover:bg-surface-muted',
	plain: 'border-transparent bg-transparent text-secondary hover:bg-surface-muted hover:text-foreground',
} satisfies Record<NonNullable<CopyButtonProps['variant']>, string>

const resetAfterMs = 1900

// Arc's copy feedback is slower than its other swaps: a 0.5s spring and 0.36s fades, here at 0.7x.
const settle = { type: 'spring', visualDuration: 0.35, bounce: 0.06 } as const
const enter = { duration: 0.252, ease: motionTokens.ease.enter } as const
const leave = { duration: 0.14, ease: motionTokens.ease.standard } as const
const instant = { duration: motionTokens.duration.instant } as const
const soft = `blur(${motionTokens.blur.soft}px)`
const rest: TargetAndTransition = { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }
const fadeIn: TargetAndTransition = { ...rest, opacity: 0 }
const fadeOut: TargetAndTransition = { opacity: 0, transition: instant }
const iconIn: TargetAndTransition = { opacity: 0, scale: 0.6, filter: soft }
const iconOut: TargetAndTransition = {
	opacity: 0,
	scale: 0.6,
	filter: soft,
	transition: { duration: 0.168, ease: motionTokens.ease.standard },
}
const iconEnter: Transition = {
	scale: settle,
	opacity: { ...enter, delay: 0.021 },
	filter: { ...enter, delay: 0.021 },
}
const glyphIn: TargetAndTransition = { opacity: 0, y: 4, filter: soft }
const glyphOut: TargetAndTransition = { opacity: 0, y: -3, filter: soft, transition: leave }

export function CopyButton({
	value,
	label = 'Copy',
	iconOnly = false,
	variant = 'outline',
	disabled,
	onCopied,
	onError,
	className,
}: CopyButtonProps) {
	const [state, setState] = useState<CopyState>('idle')
	const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
	useEffect(() => () => clearTimeout(resetTimer.current), [])
	const reduced = useReducedMotion() ?? false
	const text = state === 'copied' ? 'Copied' : state === 'error' ? 'Failed' : label

	async function copy() {
		clearTimeout(resetTimer.current)
		try {
			await navigator.clipboard.writeText(value)
			setState('copied')
			onCopied?.()
		} catch {
			setState('error')
			onError?.()
		}
		resetTimer.current = setTimeout(() => setState('idle'), resetAfterMs)
	}

	return (
		<>
			<button
				type='button'
				aria-label={label}
				data-copy-state={state}
				disabled={disabled}
				onClick={() => void copy()}
				className={cn(
					'inline-flex min-h-control-sm max-w-full press items-center justify-center gap-1.5 rounded-control border text-sm font-medium disabled:opacity-50',
					variants[variant],
					iconOnly ? 'w-control-sm motion-safe:active:scale-96!' : 'w-max px-2.5',
					className,
				)}
			>
				<span aria-hidden='true' className='relative grid size-4 shrink-0'>
					<AnimatePresence initial={false}>
						<motion.span
							key={state}
							initial={reduced ? fadeIn : iconIn}
							animate={rest}
							exit={reduced ? fadeOut : iconOut}
							transition={reduced ? instant : iconEnter}
							className={cn(
								'absolute inset-0 grid place-items-center',
								state === 'copied' && 'text-success',
								state === 'error' && 'text-danger',
							)}
						>
							{state === 'copied' ? (
								<DrawnCheck reduced={reduced} />
							) : state === 'error' ? (
								<IconAlertCircle size={16} stroke={1.75} />
							) : (
								<IconCopy size={16} stroke={1.75} />
							)}
						</motion.span>
					</AnimatePresence>
				</span>
				{!iconOnly && (
					<span
						aria-hidden='true'
						className='-mx-1 grid min-w-0 overflow-x-clip px-1 text-left whitespace-nowrap'
					>
						<span className='invisible col-start-1 row-start-1'>{label}</span>
						<span className='invisible col-start-1 row-start-1'>Copied</span>
						<span className='invisible col-start-1 row-start-1'>Failed</span>
						<MorphText text={text} reduced={reduced} />
					</span>
				)}
			</button>
			<span role='status' aria-live='polite' className='sr-only'>
				{state === 'idle' ? '' : state === 'error' ? `${label}: Could not copy` : `${label}: Copied`}
			</span>
		</>
	)
}

function DrawnCheck({ reduced }: { reduced: boolean }) {
	return (
		<svg
			width={16}
			height={16}
			viewBox='0 0 24 24'
			fill='none'
			stroke='currentColor'
			strokeWidth={1.75}
			strokeLinecap='round'
			strokeLinejoin='round'
		>
			<motion.path
				d='M4 12l5 5L20 6'
				initial={reduced ? false : { pathLength: 0, opacity: 0 }}
				animate={{ pathLength: 1, opacity: 1 }}
				transition={{
					pathLength: { duration: 0.35, ease: motionTokens.ease.standard, delay: 0.035 },
					opacity: { duration: 0.01, delay: 0.035 },
				}}
			/>
		</svg>
	)
}

// The letters glide inside the label only, so a moving button carries them instead of leaving them behind.
// Arc renders its demos inside a LayoutGroup: its re-render when the old letters leave is what glides the new ones into place.
function MorphText({ text, reduced }: { text: string; reduced: boolean }) {
	const glyphs = useGlyphs(text)
	return (
		<motion.span
			layoutRoot
			className='relative col-start-1 row-start-1 inline-flex justify-self-start whitespace-pre'
		>
			<LayoutGroup>
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
									? instant
									: { ...enter, delay: Math.min(glyph.order * 0.014, 0.084), layout: settle }
							}
							className='inline-block'
						>
							{glyph.char}
						</motion.span>
					))}
				</AnimatePresence>
			</LayoutGroup>
		</motion.span>
	)
}

type Glyph = { id: string; char: string; order: number }

function toGlyphs(chars: string[], seq: number): Glyph[] {
	return chars.map((char, order) => ({ id: `${seq}:${order}`, char, order }))
}

// Shared leading and trailing letters (two or more) keep their identity: "Copy link" to "Copied" replaces only "y link".
function useGlyphs(text: string) {
	const [shown, setShown] = useState(() => ({ text, seq: 0, glyphs: toGlyphs([...text], 0) }))
	if (shown.text === text) return shown.glyphs
	const previous = [...shown.text]
	const next = [...text]
	let start = 0
	let end = 0
	while (start < previous.length && start < next.length && previous[start] === next[start]) start++
	while (
		end < previous.length - start &&
		end < next.length - start &&
		previous[previous.length - 1 - end] === next[next.length - 1 - end]
	)
		end++
	if (start < 2) start = 0
	if (end < 2) end = 0
	const seq = shown.seq + 1
	const glyphs = [
		...shown.glyphs.slice(0, start),
		...toGlyphs(next.slice(start, next.length - end), seq),
		...shown.glyphs.slice(shown.glyphs.length - end),
	]
	setShown({ text, seq, glyphs })
	return glyphs
}
