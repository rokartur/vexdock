import {
	Fragment,
	type KeyboardEvent,
	type PointerEvent,
	type Ref,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { IconMinus, IconPlus } from '@tabler/icons-react'
import { cn } from 'cn'
import {
	AnimatePresence,
	animate,
	motion,
	type MotionValue,
	useMotionValue,
	useReducedMotion,
	useTransform,
	type Variants,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

/** Text beside the number. A function receives the value, so a unit can follow it: `n => n === 1 ? " seat" : " seats"`. */
export type NumberFieldAffix = string | ((value: number) => string)
export type NumberFieldSize = 'sm' | 'md' | 'lg'

type NumberFieldProps = {
	label: string
	value?: number
	defaultValue?: number
	onValueChange?: (value: number) => void
	min?: number
	max?: number
	step?: number
	/** PageUp, PageDown, and Shift with an arrow move this far. Defaults to ten steps. */
	largeStep?: number
	description?: string
	disabled?: boolean
	id?: string
	prefix?: NumberFieldAffix
	suffix?: NumberFieldAffix
	/** Drag the label sideways to scrub the value, one step every few pixels. */
	scrub?: boolean
	/** Fixed by default so server and client render the same digits. */
	locale?: string
	/** Fraction digits follow the precision of `step` by default. */
	formatOptions?: {
		minimumFractionDigits?: number
		maximumFractionDigits?: number
		useGrouping?: boolean
	}
	size?: NumberFieldSize
	/** A note beside the label when a press meets a limit or a typed value passes one. `false` hides it; a function writes the copy. */
	limitHint?: boolean | ((edge: 'min' | 'max', limit: number) => string)
}

type Source = 'button' | 'key' | 'scrub' | 'type'
type Part = { key: string; digit: number } | { key: string; text: string }

// Arc's 36/44/52 control with 28/34/40 steps, one step tighter: the step fills the shell less its inset and border.
const sizes = {
	sm: {
		field: '[--nf-height:var(--spacing-control-sm)] [--nf-step:20px] [--nf-inset:3px] [--nf-width:var(--number-field-width,164px)]',
		label: 'text-xs',
		value: 'text-sm',
	},
	md: {
		field: '[--nf-height:var(--spacing-control-md)] [--nf-step:28px] [--nf-inset:3px] [--nf-width:var(--number-field-width,196px)]',
		label: 'text-sm',
		value: 'text-base',
	},
	lg: {
		field: '[--nf-height:var(--spacing-control-lg)] [--nf-step:34px] [--nf-inset:4px] [--nf-width:var(--number-field-width,228px)]',
		label: 'text-sm',
		value: 'text-lg',
	},
} satisfies Record<NumberFieldSize, { field: string; label: string; value: string }>

const { spring, duration, blur } = motionTokens
const enterEase = motionTokens.ease.enter
const exitEase = motionTokens.ease.standard
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
/** Pixels of label drag per step, the pause before a held control repeats, and the fastest repeat. */
const SCRUB_PX = 6
const HOLD_DELAY = 400
const HOLD_FASTEST = 40
/** A held press keeps leaning on a limit at this cadence; the limit note stays this long; an under-minimum draft waits this
 * long before it warns, since a short draft is often on its way to a larger number. */
const LIMIT_PUSH = 240
const LIMIT_HINT_MS = 1500
const UNDER_WARN_MS = 700
/** Pushes within this window count as one effort, so each strains a little further, up to the cap. */
const PUSH_WINDOW = 700
const PUSH_GAIN = 0.22
const PUSH_CAP = 4
/** Motion drops velocity on time-defined springs, so the strain kick runs the morph spring as stiffness and damping. */
const BUMP_VELOCITY = 130
const kickRoot = (2 * Math.PI) / (spring.morph.visualDuration * 1.2)
const kick = {
	type: 'spring' as const,
	stiffness: kickRoot * kickRoot,
	damping: 2 * (1 - spring.morph.bounce) * kickRoot,
}

const decimalsOf = (value: number) => (String(value).split('.')[1] ?? '').length
const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\-]/g, '\\$&')
const affixText = (affix: NumberFieldAffix | undefined, value: number) =>
	typeof affix === 'function' ? affix(value) : (affix ?? '')
/** iOS style resistance: travel past a limit gives less and less, and never more than `limit` pixels. */
const rubber = (distance: number, limit = 10) =>
	Math.sign(distance) * (1 - 1 / ((Math.abs(distance) * 0.55) / limit + 1)) * limit

/** Columns are keyed by place value, so 9 → 10 keeps the ones column the ones column. */
function partsOf(value: number, format: Intl.NumberFormat): Part[] {
	const parts = format.formatToParts(value)
	let place = 0
	for (const part of parts) if (part.type === 'integer') place += part.value.length
	let fraction = 0
	return parts.flatMap((part, index): Part[] => {
		if (part.type === 'integer') return [...part.value].map(char => ({ key: `i${--place}`, digit: Number(char) }))
		if (part.type === 'fraction')
			return [...part.value].map(char => ({ key: `f${fraction++}`, digit: Number(char) }))
		return [{ key: symbolKey(part.type, place, index), text: part.value }]
	})
}

function symbolKey(type: Intl.NumberFormatPartTypes, place: number, index: number) {
	if (type === 'group') return `g${place}`
	if (type === 'decimal') return 'd'
	if (type === 'minusSign') return 'm'
	return `${type}${index}`
}

// A column opens its width while it rises in the direction of change and closes on a critically damped spring, so it never
// passes zero. Scale and opacity ride the width spring, so a digit grows with its slot instead of landing on its neighbours.
const slot: Variants = {
	enter: (direction: number) => ({
		width: 0,
		scale: 0.6,
		opacity: 0,
		y: `${direction * 0.3}em`,
		filter: `blur(${blur.soft}px)`,
	}),
	center: {
		width: 'auto',
		scale: 1,
		opacity: 1,
		y: 0,
		filter: 'blur(0px)',
		transitionEnd: { filter: 'none' },
		transition: {
			width: spring.morph,
			scale: spring.morph,
			opacity: spring.morph,
			y: spring.snappy,
			filter: { duration: 0.21, ease: exitEase },
		},
	},
	exit: (direction: number) => ({
		width: 0,
		scale: 0.6,
		opacity: 0,
		y: `${direction * -0.3}em`,
		filter: `blur(${blur.subtle}px)`,
		transition: {
			width: spring.smooth,
			scale: spring.smooth,
			y: { duration: duration.fast, ease: exitEase },
			opacity: { duration: duration.instant },
			filter: { duration: duration.instant },
		},
	}),
}
// Reduced motion keeps a short fade and no travel; while typing, columns follow the draft at once so they never lag the caret.
const rest = (opacity: number) => ({ width: 'auto', scale: 1, opacity, y: 0, filter: 'none' })
const still: Variants = {
	enter: rest(0),
	center: { ...rest(1), transition: { duration: duration.instant } },
	exit: { width: 0, opacity: 0, transition: { duration: 0 } },
}
const cut: Variants = {
	enter: rest(1),
	center: { ...rest(1), transition: { duration: 0 } },
	exit: { width: 0, opacity: 0, transition: { duration: 0 } },
}

/** One digit on the wheel. Its distance from the wheel position sets where it sits, how clear it is, and whether it shows. */
function Glyph({ position, digit }: { position: MotionValue<number>; digit: number }) {
	// Every style reads the wheel directly: a chained transform can update a frame late and leave the wheel blank on a jump.
	const offset = (current: number) => ((((digit - current) % 10) + 15) % 10) - 5
	const y = useTransform(position, current => `${offset(current) * 1.05}em`)
	// An eased falloff keeps a turning digit legible through the middle of the roll.
	const opacity = useTransform(position, current => Math.max(0, 1 - Math.abs(offset(current)) ** 1.5 * 1.1))
	const visibility = useTransform(position, current => (Math.abs(offset(current)) >= 1 ? 'hidden' : 'visible'))
	const filter = useTransform(position, current => {
		const distance = Math.abs(offset(current))
		return distance < 0.02 || distance >= 1 ? 'none' : `blur(${(distance * blur.soft * 0.75).toFixed(2)}px)`
	})
	return (
		<motion.span
			className='absolute inset-x-0 inset-y-(--feather) text-center'
			style={{ y, opacity, filter, visibility }}
		>
			{digit}
		</motion.span>
	)
}

/** An odometer wheel. It turns the way the whole number moved, wraps 9 → 0, and retargets mid spin when steps arrive quickly. */
function Wheel({ digit, direction, instant }: { digit: number; direction: number; instant: boolean }) {
	const reduced = useReducedMotion()
	const position = useMotionValue(digit)
	const wheel = useRef({ digit, target: digit })
	useLayoutEffect(() => {
		const state = wheel.current
		if (state.digit === digit) return
		// Turn the way the number moved unless that is more than half a turn; then the short way, so a big clamp never spins.
		let delta = direction > 0 ? (digit - state.digit + 10) % 10 : -((state.digit - digit + 10) % 10)
		if (Math.abs(delta) > 5) delta -= Math.sign(delta) * 10
		state.target += delta
		state.digit = digit
		if (instant || reduced) position.jump(state.target)
		else animate(position, state.target, spring.snappy)
	}, [digit, direction, instant, position, reduced])
	return (
		<>
			<span className='invisible'>0</span>
			{DIGITS.map(item => (
				<Glyph key={item} position={position} digit={item} />
			))}
		</>
	)
}

function Digits({
	value,
	format,
	direction,
	instant,
}: {
	value: number
	format: Intl.NumberFormat
	direction: number
	instant: boolean
}) {
	const reduced = useReducedMotion()
	const variants = instant ? cut : reduced ? still : slot
	return (
		<AnimatePresence initial={false} custom={direction}>
			{partsOf(value, format).map(part => (
				<motion.span
					key={part.key}
					className={
						'digit' in part
							? 'relative -my-(--feather) inline-block overflow-x-visible overflow-y-clip [mask-image:linear-gradient(to_bottom,transparent,black_calc(var(--feather)*1.5),black_calc(100%-var(--feather)*1.5),transparent)] [mask-clip:no-clip] [mask-repeat:repeat-x] py-(--feather) [--feather:.2em]'
							: 'inline-block overflow-x-clip whitespace-pre'
					}
					custom={direction}
					variants={variants}
					initial='enter'
					animate='center'
					exit='exit'
				>
					{'digit' in part ? <Wheel digit={part.digit} direction={direction} instant={instant} /> : part.text}
				</motion.span>
			))}
		</AnimatePresence>
	)
}

/** Characters are keyed by position, so "seat" → "seats" only opens the new "s" and the rest holds still. */
function AffixText({ text, direction }: { text: string; direction: number }) {
	const reduced = useReducedMotion()
	return (
		<span className='inline-flex font-normal text-secondary'>
			<AnimatePresence initial={false} custom={direction}>
				{[...text].map((char, index) => (
					<motion.span
						key={`${index}:${char}`}
						className='inline-block overflow-x-clip whitespace-pre'
						custom={direction}
						variants={reduced ? still : slot}
						initial='enter'
						animate='center'
						exit='exit'
					>
						{char}
					</motion.span>
				))}
			</AnimatePresence>
		</span>
	)
}

const numberIn = (word?: string) => {
	const digits = word?.replaceAll(/[^\d.-]/g, '')
	return digits && /\d/.test(digits) && Number.isFinite(Number(digits)) ? Number(digits) : null
}
/** A number word rolls down when it shrank and up when it grew; any other changed word rises. */
function directionsBetween(from: string, to: string) {
	const before = from.split(' ')
	return to.split(' ').map((word, index) => {
		const a = numberIn(before[index])
		const b = numberIn(word)
		return a !== null && b !== null && b < a ? -1 : 1
	})
}

const wordRise: Variants = {
	enter: (direction: number) => ({
		opacity: 0,
		y: `${direction * 0.3}em`,
		filter: `blur(${blur.soft}px)`,
	}),
	// Opacity follows the slot's width spring, so a longer word never shows before its room has opened.
	center: {
		opacity: 1,
		y: 0,
		filter: 'blur(0px)',
		transitionEnd: { filter: 'none' },
		transition: { duration: 0.154, ease: enterEase, opacity: spring.morph },
	},
	exit: (direction: number) => ({
		opacity: 0,
		y: `${direction * -0.3}em`,
		filter: `blur(${blur.subtle}px)`,
		transition: { duration: 0.098, ease: exitEase },
	}),
}
const wordFade: Variants = {
	enter: { opacity: 0, y: 0, filter: 'none' },
	center: { opacity: 1, y: 0, filter: 'none', transition: { duration: duration.instant } },
	exit: { opacity: 0, transition: { duration: 0 } },
}

/** A word's width follows its new copy on a spring, so a price gaining a digit eases the rest of the line along. */
function WordSlot({ word, direction }: { word: string; direction: number }) {
	const reduced = useReducedMotion()
	const sizerRef = useRef<HTMLSpanElement>(null)
	const width = useMotionValue<number | 'auto'>('auto')
	const measured = useRef(false)
	useLayoutEffect(() => {
		const node = sizerRef.current
		if (!node) return
		const observer = new ResizeObserver(() => {
			if (!measured.current || reduced) width.jump(node.offsetWidth)
			else animate(width, node.offsetWidth, spring.morph)
			measured.current = true
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [reduced, width])
	return (
		<motion.span className='relative inline-block align-top whitespace-pre' style={{ width }}>
			<span ref={sizerRef} className='invisible absolute top-0 left-0 whitespace-pre'>
				{word}
			</span>
			<AnimatePresence initial={false} mode='popLayout' custom={direction}>
				<motion.span
					key={word}
					className='inline-block whitespace-pre'
					custom={direction}
					variants={reduced ? wordFade : wordRise}
					initial='enter'
					animate='center'
					exit='exit'
				>
					{word}
				</motion.span>
			</AnimatePresence>
		</motion.span>
	)
}

/** Changed words rise in and unblur while unchanged words hold still. Assistive tech reads the plain copy. */
function MotionText({ text }: { text: string }) {
	const [trail, setTrail] = useState({ text, directions: [] as number[] })
	if (trail.text !== text) setTrail({ text, directions: directionsBetween(trail.text, text) })
	const directions = trail.text === text ? trail.directions : directionsBetween(trail.text, text)
	// Spaces live between the slots, so a word still opening its width never runs into the next one.
	return (
		<>
			<span className='sr-only'>{text}</span>
			<span className='relative block' aria-hidden='true'>
				{text.split(' ').map((word, position) => (
					<Fragment key={position}>
						{position > 0 && ' '}
						<WordSlot word={word} direction={directions[position] ?? 1} />
					</Fragment>
				))}
			</span>
		</>
	)
}

/** The row opens its height on a spring, then the words settle in. */
function FieldMessage({ id, text }: { id?: string; text?: string }) {
	return (
		<AnimatePresence initial={false}>
			{text ? <MessageRow key='message' id={id} text={text} /> : null}
		</AnimatePresence>
	)
}

/** The row tracks the measured copy, so a longer message that wraps opens its next line instead of snapping. */
function MessageRow({ id, text }: { id?: string; text: string }) {
	const reduced = useReducedMotion()
	const copyRef = useRef<HTMLSpanElement>(null)
	const [height, setHeight] = useState<number | 'auto'>('auto')
	useLayoutEffect(() => {
		const node = copyRef.current
		if (!node) return
		const observer = new ResizeObserver(([entry]) =>
			setHeight(entry?.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight),
		)
		observer.observe(node)
		return () => observer.disconnect()
	}, [])
	return (
		<motion.span
			className='block overflow-hidden'
			initial={{ height: 0, opacity: 0 }}
			animate={{ height, opacity: 1 }}
			exit={{
				height: 0,
				opacity: 0,
				transition: reduced
					? { duration: 0 }
					: { height: spring.smooth, opacity: { duration: duration.instant } },
			}}
			transition={reduced ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.fast } }}
		>
			<motion.span
				ref={copyRef}
				id={id}
				className='block pt-2 text-xs text-muted tabular-nums'
				initial={reduced ? false : { y: '0.35em', filter: `blur(${blur.soft}px)` }}
				animate={{ y: 0, filter: 'blur(0px)' }}
				transition={{ duration: reduced ? 0 : duration.standard, ease: enterEase }}
			>
				<MotionText text={text} />
			</motion.span>
		</motion.span>
	)
}

/** The limit note rises in from the side it guards (up for a maximum, down for a minimum) and fades out in place. */
function LimitNote({ id, edge, text }: { id: string; edge: 1 | -1 | 0; text: string }) {
	const reduced = useReducedMotion()
	return (
		<AnimatePresence initial={false}>
			{edge !== 0 && (
				<motion.span
					key='limit'
					id={id}
					className='flex-none text-xs font-medium whitespace-nowrap text-(--nf-limit) tabular-nums'
					initial={
						reduced
							? { opacity: 0 }
							: { opacity: 0, y: `${edge * 0.45}em`, filter: `blur(${blur.subtle}px)` }
					}
					animate={{ opacity: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
					exit={{
						opacity: 0,
						transition: {
							duration: reduced ? duration.instant : duration.standard,
							ease: exitEase,
						},
					}}
					transition={
						reduced
							? { duration: duration.instant }
							: {
									y: spring.snappy,
									opacity: { duration: duration.fast },
									filter: { duration: duration.fast },
								}
					}
				>
					{text}
				</motion.span>
			)}
		</AnimatePresence>
	)
}

const strainedStep = {
	1: 'group-data-[strain=max]/control:aria-disabled:text-(--nf-limit) group-data-[strain=max]/control:aria-disabled:opacity-60 group-data-[strain=max]/control:aria-disabled:[transition:opacity_85ms_linear,color_85ms_linear]',
	[-1]: 'group-data-[strain=min]/control:aria-disabled:text-(--nf-limit) group-data-[strain=min]/control:aria-disabled:opacity-60 group-data-[strain=min]/control:aria-disabled:[transition:opacity_85ms_linear,color_85ms_linear]',
}

/** Pointer presses hold to repeat; keyboard and assistive clicks (detail 0) take one step. */
function StepButton({
	toward,
	label,
	disabled,
	controls,
	limit,
	pressed,
	iconRef,
	onPress,
	onRelease,
	onActivate,
}: {
	toward: 1 | -1
	label: string
	disabled?: boolean
	controls: string
	limit: boolean
	pressed: boolean
	iconRef: Ref<HTMLSpanElement>
	onPress: () => void
	onRelease: () => void
	onActivate: () => void
}) {
	const Icon = toward > 0 ? IconPlus : IconMinus
	// A limit dims the button but keeps it focusable, so a press there strains the value instead of dropping focus.
	// Mouse presses keep focus where it was: an open draft commits with the step, and the stepper never steals the ring.
	return (
		<button
			type='button'
			className={cn(
				'group/step grid size-(--nf-step) flex-[0_0_var(--nf-step)] place-items-center rounded-[calc(var(--radius-control)-var(--nf-inset)-1px)] text-secondary [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none] [transition:background-color_110ms_var(--ease-standard),color_110ms_var(--ease-standard),opacity_170ms_var(--ease-standard)]',
				'hover:not-aria-disabled:bg-surface-muted hover:not-aria-disabled:text-foreground focus-visible:bg-surface-muted focus-visible:text-foreground',
				'active:not-aria-disabled:bg-[color-mix(in_oklab,var(--foreground)_10%,var(--surface))] active:not-aria-disabled:text-foreground active:not-aria-disabled:[transition:background-color_85ms_linear,color_85ms_linear]',
				'data-pressed:not-disabled:not-aria-disabled:bg-[color-mix(in_oklab,var(--foreground)_10%,var(--surface))] data-pressed:not-disabled:not-aria-disabled:text-foreground data-pressed:not-disabled:not-aria-disabled:[transition:background-color_85ms_linear,color_85ms_linear]',
				'disabled:opacity-35 aria-disabled:cursor-not-allowed aria-disabled:opacity-32',
				strainedStep[toward],
			)}
			disabled={disabled}
			aria-controls={controls}
			aria-label={`${toward > 0 ? 'Increase' : 'Decrease'} ${label}`}
			aria-disabled={limit || undefined}
			data-pressed={pressed || undefined}
			onPointerDown={event => {
				if (event.button === 0) onPress()
			}}
			onPointerUp={onRelease}
			onPointerLeave={onRelease}
			onPointerCancel={onRelease}
			onMouseDown={event => event.preventDefault()}
			onClick={event => {
				if (event.detail === 0) onActivate()
			}}
			onContextMenu={event => event.preventDefault()}
		>
			<span ref={iconRef} className='grid place-items-center'>
				<Icon
					size={16}
					stroke={1.75}
					aria-hidden='true'
					className='transition-[scale] duration-400 ease-spring motion-safe:group-active/step:group-not-aria-disabled/step:scale-82 motion-safe:group-active/step:group-not-aria-disabled/step:duration-85 motion-safe:group-active/step:group-not-aria-disabled/step:ease-standard motion-safe:group-data-pressed/step:group-not-disabled/step:group-not-aria-disabled/step:scale-82 motion-safe:group-data-pressed/step:group-not-disabled/step:group-not-aria-disabled/step:duration-85 motion-safe:group-data-pressed/step:group-not-disabled/step:group-not-aria-disabled/step:ease-standard'
				/>
			</span>
		</button>
	)
}

function keyMove(event: KeyboardEvent<HTMLInputElement>, step: number, large: number) {
	if (event.key === 'ArrowUp') return { toward: 1 as const, amount: event.shiftKey ? large : step }
	if (event.key === 'ArrowDown') return { toward: -1 as const, amount: event.shiftKey ? large : step }
	if (event.key === 'PageUp') return { toward: 1 as const, amount: large }
	if (event.key === 'PageDown') return { toward: -1 as const, amount: large }
	return null
}

/**
 * A bounded number with odometer digits. Buttons and arrow keys repeat and speed up while held, PageUp and PageDown take large
 * steps, Home and End jump to the limits, and `scrub` lets the label be dragged. Typing edits a plain draft that applies live
 * while valid; the rolling digits return once it commits on Enter, blur, or the next step.
 */
export function NumberField({
	label,
	value,
	defaultValue = 0,
	onValueChange,
	min = 0,
	max = Number.MAX_SAFE_INTEGER,
	step: stepProp = 1,
	largeStep,
	description,
	disabled,
	id,
	prefix,
	suffix,
	scrub = false,
	locale = 'en-US',
	formatOptions,
	size = 'md',
	limitHint = true,
}: NumberFieldProps) {
	const reduced = useReducedMotion()
	const generatedId = useId()
	const inputId = id ?? generatedId
	const hintId = description ? `${inputId}-description` : undefined
	const limitId = `${inputId}-limit`
	const step = stepProp > 0 ? stepProp : 1
	const [internal, setInternal] = useState(defaultValue)
	const current = value ?? internal
	const [draft, setDraft] = useState('')
	const [editing, setEditing] = useState(false)
	const [pressed, setPressed] = useState(0)
	const [scrubbing, setScrubbing] = useState(false)
	const [announcement, setAnnouncement] = useState('')
	/** The limit a press just met, shown for a moment; and whether a draft under the minimum has sat long enough to warn. */
	const [pushed, setPushed] = useState<1 | -1 | 0>(0)
	const [underWarn, setUnderWarn] = useState(false)
	const controlRef = useRef<HTMLDivElement>(null)
	const minusIcon = useRef<HTMLSpanElement>(null)
	const plusIcon = useRef<HTMLSpanElement>(null)
	const pushedTimer = useRef<number | undefined>(undefined)
	const underTimer = useRef<number | undefined>(undefined)
	const strainTimer = useRef<number | undefined>(undefined)
	const effort = useRef({ edge: 0, count: 0, at: 0 })
	const inputRef = useRef<HTMLInputElement>(null)
	const groupRef = useRef<HTMLSpanElement>(null)
	const latest = useRef(current)
	const editStart = useRef(current)
	const hold = useRef<number | undefined>(undefined)
	const drag = useRef<{ pointer: number; x: number; from: number; active: boolean } | null>(null)
	const suppressClick = useRef(false)
	const shiftFrom = useRef<number | null>(null)
	const selectNext = useRef(false)
	const live = useRef<(toward: 1 | -1, steps: number, source: Source) => boolean>(() => false)
	const bumpY = useMotionValue(0)
	const scrubX = useMotionValue(0)
	const shiftX = useMotionValue(0)
	const x = useTransform(() => scrubX.get() + shiftX.get())

	const base = Number.isFinite(min) ? min : 0
	const decimals = Math.max(decimalsOf(step), decimalsOf(base))
	const minFraction = formatOptions?.minimumFractionDigits ?? decimals
	const maxFraction = Math.max(minFraction, formatOptions?.maximumFractionDigits ?? decimals)
	const grouping = formatOptions?.useGrouping ?? true
	const format = useMemo(
		() =>
			new Intl.NumberFormat(locale, {
				minimumFractionDigits: minFraction,
				maximumFractionDigits: maxFraction,
				useGrouping: grouping,
				numberingSystem: 'latn',
			}),
		[locale, minFraction, maxFraction, grouping],
	)
	const symbols = useMemo(() => {
		const parts = new Intl.NumberFormat(locale).formatToParts(-1234.5)
		return {
			group: parts.find(part => part.type === 'group')?.value ?? ',',
			decimal: parts.find(part => part.type === 'decimal')?.value ?? '.',
		}
	}, [locale])
	const round = (next: number) => Number(next.toFixed(decimals)) || 0
	const clamp = (next: number) => Math.min(max, Math.max(min, next))
	const snap = (next: number) => round(base + Math.round((next - base) / step) * step)
	/** Off-grid values move to the next grid line in the direction of travel, then whole steps from there. */
	const stepFrom = (from: number, steps: number) => {
		const index = (from - base) / step
		const grid = steps > 0 ? Math.floor(index + 1e-7) : Math.ceil(index - 1e-7)
		return round(base + (grid + steps) * step)
	}
	const spoken = (next: number) => `${affixText(prefix, next)}${format.format(next)}${affixText(suffix, next)}`.trim()
	function parse(text: string) {
		const normalized = text
			.split(symbols.group)
			.join('')
			.replace(symbols.decimal, '.')
			.replaceAll(/[^\d.-]/g, '')
		if (!/\d/.test(normalized)) return null
		const parsed = Number(normalized)
		return Number.isFinite(parsed) ? parsed : null
	}
	const typed = editing ? parse(draft) : null
	const shown = typed ?? current
	const [trail, setTrail] = useState({ value: shown, direction: 1 as 1 | -1 })
	if (trail.value !== shown) setTrail({ value: shown, direction: shown > trail.value ? 1 : -1 })
	const direction = trail.value === shown ? trail.direction : shown > trail.value ? 1 : -1

	useEffect(
		() => () => {
			window.clearTimeout(hold.current)
			window.clearTimeout(pushedTimer.current)
			window.clearTimeout(underTimer.current)
			window.clearTimeout(strainTimer.current)
		},
		[],
	)

	/** A press past a limit. The value strains toward it and springs home, a little further with each push in a row (capped,
	 * like overscroll); the refused button shakes once; the note names the limit. Reduced motion keeps a brief color change. */
	function strain(edge: 1 | -1, source: Source) {
		const now = performance.now()
		const push = effort.current
		push.count = push.edge === edge && now - push.at < PUSH_WINDOW ? push.count + 1 : 1
		push.edge = edge
		push.at = now
		const control = controlRef.current
		if (control) {
			control.dataset.strain = edge > 0 ? 'max' : 'min'
			window.clearTimeout(strainTimer.current)
			strainTimer.current = window.setTimeout(() => {
				delete control.dataset.strain
			}, 420)
		}
		if (!reduced) {
			const velocity = -edge * BUMP_VELOCITY * (1 + Math.min(push.count - 1, PUSH_CAP) * PUSH_GAIN)
			animate(bumpY, 0, { ...kick, velocity })
			const icon = (edge > 0 ? plusIcon : minusIcon).current
			if (icon && (source === 'button' || source === 'key'))
				animate(icon, { x: [0, -2.5, 2.5, -1.5, 1, 0] }, { duration: 0.224, ease: 'easeOut' })
		}
		if (limitHint) {
			setPushed(edge)
			window.clearTimeout(pushedTimer.current)
			pushedTimer.current = window.setTimeout(() => setPushed(0), LIMIT_HINT_MS)
		}
	}
	/** Every change lands here. A value past a limit clamps, strains toward it, and says which limit it met. */
	function commitValue(next: number, source: Source) {
		if (!Number.isFinite(next)) return false
		const clamped = clamp(next)
		const limit = Math.sign(next - clamped)
		if (limit && source !== 'scrub') {
			strain(limit > 0 ? 1 : -1, source)
			setAnnouncement(`${spoken(clamped)}, ${limit > 0 ? 'maximum' : 'minimum'}`)
		} else if (source === 'button' && clamped !== latest.current) setAnnouncement(spoken(clamped))
		if (clamped === latest.current) return false
		latest.current = clamped
		if (value === undefined) setInternal(clamped)
		onValueChange?.(clamped)
		return true
	}
	const nudge = (toward: 1 | -1, steps: number, source: Source) =>
		commitValue(stepFrom(latest.current, toward * steps), source)
	useLayoutEffect(() => {
		latest.current = current
		live.current = nudge
	})

	/** The group glides back to center when typing changes its width, instead of hopping half a character per key. */
	function captureShift() {
		const group = groupRef.current
		if (group && shiftFrom.current === null)
			shiftFrom.current = group.getBoundingClientRect().left - scrubX.get() - shiftX.get()
	}
	useLayoutEffect(() => {
		const from = shiftFrom.current
		const group = groupRef.current
		shiftFrom.current = null
		// After a commit the caret collapses to the end, so no selection box sits over the rolling digits.
		if (selectNext.current) {
			selectNext.current = false
			const input = inputRef.current
			if (input && document.activeElement === input) {
				const end = input.value.length
				input.setSelectionRange(end, end)
			}
		}
		if (from === null || !group) return
		const delta = from - (group.getBoundingClientRect().left - scrubX.get() - shiftX.get())
		if (Math.abs(delta) < 0.5) return
		shiftX.set(shiftX.get() + delta)
		if (reduced) shiftX.jump(0)
		else animate(shiftX, 0, spring.morph)
	})

	function clearUnder() {
		window.clearTimeout(underTimer.current)
		setUnderWarn(false)
	}
	function commitDraft() {
		if (!editing) return
		captureShift()
		setEditing(false)
		clearUnder()
		const parsed = parse(draft)
		if (parsed !== null) commitValue(snap(parsed), 'type')
	}
	function stopHold() {
		window.clearTimeout(hold.current)
		hold.current = undefined
		setPressed(0)
	}
	/** One step now; after a pause, repeats that speed up gently until release. Held into a limit, it keeps leaning on it at a
	 * steady cadence, each push straining a little further, until the press lets go. */
	function startHold(toward: 1 | -1, amount: number, source: Source) {
		stopHold()
		commitDraft()
		const steps = Math.max(1, Math.round(amount / step))
		if (source === 'button') setPressed(toward)
		let count = 0
		const tick = () => {
			const moved = live.current(toward, steps, source)
			if (moved) count += 1
			hold.current = window.setTimeout(tick, moved ? Math.max(HOLD_FASTEST, 150 * 0.86 ** count) : LIMIT_PUSH)
		}
		hold.current = window.setTimeout(tick, nudge(toward, steps, source) ? HOLD_DELAY : LIMIT_PUSH + 120)
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		const move = keyMove(event, step, largeStep ?? step * 10)
		if (move) {
			event.preventDefault()
			if (!event.repeat) startHold(move.toward, move.amount, 'key')
			return
		}
		// Home and End reach the limits; while a draft is open they move the caret as in any text field.
		const toLimit =
			(event.key === 'Home' && Number.isFinite(min)) || (event.key === 'End' && max < Number.MAX_SAFE_INTEGER)
		if (!editing && toLimit) {
			event.preventDefault()
			commitValue(event.key === 'Home' ? min : max, 'key')
			return
		}
		if (event.key === 'Enter') {
			event.preventDefault()
			if (editing) {
				selectNext.current = true
				commitDraft()
			} else event.currentTarget.select()
		}
		if (event.key === 'Escape' && editing) {
			event.preventDefault()
			captureShift()
			setEditing(false)
			clearUnder()
			selectNext.current = true
			commitValue(editStart.current, 'type')
		}
	}
	function onChange(text: string) {
		const decimal = decimals || maxFraction ? escapeRegExp(symbols.decimal) : ''
		const allowed = new RegExp(`[^0-9${escapeRegExp(symbols.group)}${decimal}${min < 0 ? '\\-' : ''}]`, 'g')
		const next = text.replaceAll(allowed, '')
		if (!editing) editStart.current = current
		captureShift()
		setDraft(next)
		setEditing(true)
		// Valid drafts apply as they are typed, so anything that depends on the value follows along.
		const parsed = parse(next)
		if (parsed !== null && parsed >= min && parsed <= max && snap(parsed) === parsed) commitValue(parsed, 'type')
		// Past the maximum warns at once; under the minimum waits, since "1" is often the start of "12".
		clearUnder()
		if (parsed !== null && parsed < min)
			underTimer.current = window.setTimeout(() => setUnderWarn(true), UNDER_WARN_MS)
	}

	function onScrubStart(event: PointerEvent<HTMLLabelElement>) {
		suppressClick.current = false
		if (!scrub || disabled || event.button !== 0) return
		commitDraft()
		drag.current = {
			pointer: event.pointerId,
			x: event.clientX,
			from: latest.current,
			active: false,
		}
		event.currentTarget.setPointerCapture(event.pointerId)
	}
	function onScrubMove(event: PointerEvent<HTMLLabelElement>) {
		const state = drag.current
		if (!state || state.pointer !== event.pointerId) return
		const dx = event.clientX - state.x
		if (!state.active) {
			if (Math.abs(dx) < 3) return
			state.active = true
			setScrubbing(true)
		}
		const travel = dx / SCRUB_PX
		const steps = Math.trunc(travel)
		commitValue(steps ? stepFrom(state.from, steps) : state.from, 'scrub')
		// Past a limit the value follows the pointer with resistance, then springs back on release.
		const raw = state.from + travel * step
		const over = raw > max ? ((raw - max) / step) * SCRUB_PX : raw < min ? ((raw - min) / step) * SCRUB_PX : 0
		scrubX.set(reduced ? 0 : rubber(over))
	}
	function onScrubEnd(event: PointerEvent<HTMLLabelElement>) {
		const state = drag.current
		if (!state || state.pointer !== event.pointerId) return
		drag.current = null
		if (!state.active) return
		suppressClick.current = true
		setScrubbing(false)
		animate(scrubX, 0, reduced ? { duration: 0 } : spring.snappy)
		setAnnouncement(spoken(latest.current))
	}

	const stepper = (toward: 1 | -1) => ({
		toward,
		label,
		disabled,
		controls: inputId,
		limit: toward > 0 ? shown >= max : shown <= min,
		pressed: pressed === toward,
	})
	/** A typed value past a limit holds a calm warning until it commits and springs back. */
	const outside: 1 | -1 | 0 = typed === null ? 0 : typed > max ? 1 : typed < min && underWarn ? -1 : 0
	const noteEdge = limitHint ? outside || pushed : 0
	const noteLimit = noteEdge > 0 ? max : min
	const noteText = noteEdge
		? typeof limitHint === 'function'
			? limitHint(noteEdge > 0 ? 'max' : 'min', noteLimit)
			: `${noteEdge > 0 ? 'Max' : 'Min'} ${spoken(noteLimit)}`
		: ''
	const describedBy = [hintId, outside && limitHint ? limitId : undefined].filter(Boolean).join(' ') || undefined

	return (
		<div
			className={cn(
				'group/field grid min-w-0 [--nf-limit:color-mix(in_oklab,var(--warning)_72%,var(--foreground))] dark:[--nf-limit:color-mix(in_oklab,var(--warning)_88%,var(--foreground))]',
				sizes[size].field,
			)}
			data-size={size}
		>
			<div className='mb-2 flex w-[min(100%,var(--nf-width))] items-baseline justify-between gap-3'>
				<label
					htmlFor={inputId}
					className={cn(
						'min-w-0 font-medium text-foreground data-scrub:cursor-ew-resize data-scrub:touch-pan-y data-scrub:select-none',
						sizes[size].label,
					)}
					data-scrub={(scrub && !disabled) || undefined}
					onPointerDown={onScrubStart}
					onPointerMove={onScrubMove}
					onPointerUp={onScrubEnd}
					onPointerCancel={onScrubEnd}
					onClick={event => {
						if (!suppressClick.current) return
						event.preventDefault()
						suppressClick.current = false
					}}
				>
					{label}
				</label>
				<LimitNote id={limitId} edge={noteEdge} text={noteText} />
			</div>
			<div
				ref={controlRef}
				className={cn(
					'group/control flex min-h-(--nf-height) w-[min(100%,var(--nf-width))] items-center gap-0.5 rounded-control border border-border bg-surface p-(--nf-inset) [transition:border-color_110ms_var(--ease-standard),background-color_170ms_var(--ease-standard),opacity_110ms_var(--ease-standard)]',
					'hover:border-border-strong has-[input:focus]:border-foreground data-scrubbing:border-foreground pointer-fine:group-has-[[data-scrub]:hover]/field:border-border-strong',
					'data-warn:border-[color-mix(in_oklab,var(--warning)_55%,var(--border))] data-warn:bg-[color-mix(in_oklab,var(--warning)_5%,var(--surface))] data-warn:has-[input:focus]:border-[color-mix(in_oklab,var(--warning)_80%,var(--border))]',
					'data-disabled:bg-surface-muted data-disabled:opacity-50',
				)}
				data-scrubbing={scrubbing || undefined}
				data-disabled={disabled || undefined}
				data-warn={outside ? (outside > 0 ? 'max' : 'min') : undefined}
			>
				<StepButton
					{...stepper(-1)}
					iconRef={minusIcon}
					onPress={() => startHold(-1, step, 'button')}
					onRelease={stopHold}
					onActivate={() => {
						commitDraft()
						nudge(-1, 1, 'button')
					}}
				/>
				<div
					className='relative flex min-w-0 flex-1 cursor-text items-center justify-center self-stretch group-data-disabled/control:cursor-not-allowed'
					onMouseDown={event => {
						if (event.target !== inputRef.current) event.preventDefault()
					}}
					onClick={event => {
						if (disabled || event.target === inputRef.current) return
						inputRef.current?.focus()
						inputRef.current?.select()
					}}
				>
					<motion.span
						ref={groupRef}
						className={cn(
							'inline-flex items-center font-medium whitespace-nowrap text-foreground tabular-nums transition-colors duration-170 motion-reduce:group-data-strain/control:text-(--nf-limit) motion-reduce:group-data-strain/control:transition-none',
							sizes[size].value,
						)}
						style={{ x, y: bumpY }}
					>
						<AffixText text={affixText(prefix, shown)} direction={direction} />
						<span className='relative inline-grid items-center'>
							<span
								className='inline-flex [grid-area:1/1] data-hidden:invisible data-hidden:absolute data-hidden:top-0 data-hidden:left-0'
								data-hidden={editing || undefined}
								aria-hidden='true'
							>
								<Digits value={shown} format={format} direction={direction} instant={editing} />
							</span>
							{editing && (
								<span className='whitespace-pre [grid-area:1/1]' aria-hidden='true'>
									{draft}
								</span>
							)}
							<input
								ref={inputRef}
								id={inputId}
								className='absolute top-0 left-0 z-1 m-0 h-full w-[calc(100%+1em)] border-0 bg-transparent p-0 text-left leading-[inherit] tracking-[inherit] text-transparent [font-variant-numeric:inherit] caret-foreground [font:inherit] selection:bg-foreground/16 selection:text-transparent disabled:cursor-not-allowed'
								type='text'
								role='spinbutton'
								inputMode={min < 0 ? 'text' : decimals || maxFraction ? 'decimal' : 'numeric'}
								autoComplete='off'
								spellCheck={false}
								value={editing ? draft : format.format(current)}
								disabled={disabled}
								aria-describedby={describedBy}
								aria-invalid={outside ? true : undefined}
								aria-valuenow={current}
								aria-valuetext={spoken(current)}
								aria-valuemin={Number.isFinite(min) ? min : undefined}
								aria-valuemax={max < Number.MAX_SAFE_INTEGER ? max : undefined}
								onChange={event => onChange(event.currentTarget.value)}
								onKeyDown={onKeyDown}
								onKeyUp={event => {
									if (/^(?:Arrow(?:Up|Down)|Page(?:Up|Down))$/.test(event.key)) stopHold()
								}}
								onBlur={() => {
									stopHold()
									commitDraft()
								}}
							/>
						</span>
						<AffixText text={affixText(suffix, shown)} direction={direction} />
					</motion.span>
				</div>
				<StepButton
					{...stepper(1)}
					iconRef={plusIcon}
					onPress={() => startHold(1, step, 'button')}
					onRelease={stopHold}
					onActivate={() => {
						commitDraft()
						nudge(1, 1, 'button')
					}}
				/>
			</div>
			<FieldMessage id={hintId} text={description} />
			<span className='sr-only' aria-live='polite' aria-atomic='true'>
				{announcement}
			</span>
		</div>
	)
}
