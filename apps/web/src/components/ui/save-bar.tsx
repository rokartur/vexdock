import {
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type ComponentProps,
	type CSSProperties,
	type ReactNode,
	type Ref,
} from 'react'
import { IconAlertCircle } from '@tabler/icons-react'
import { cn } from 'cn'
import { animate, motion, useMotionValue } from 'motion/react'
import { createPortal } from 'react-dom'
import { motionTokens } from '../../lib/motion'
import { Button } from './button'

export type IslandBarStatus = 'hidden' | 'dirty' | 'saving' | 'saved' | 'error'
export type IslandBarNudge = { kind?: 'bump' | 'shake'; announce?: boolean; focus?: boolean }
export type IslandBarActions = { nudge: (options?: IslandBarNudge) => void }
export type IslandBarLabels = typeof LABELS

type View = Exclude<IslandBarStatus, 'hidden'>
type IslandBarProps = Omit<ComponentProps<'div'>, 'children'> & {
	status: IslandBarStatus
	message?: ReactNode
	icon?: ReactNode
	error?: ReactNode
	errorIcon?: ReactNode
	errorActions?: ReactNode
	extra?: ReactNode
	labels?: Partial<IslandBarLabels>
	shortcut?: string | null
	saveDisabled?: boolean
	onSave?: () => void
	onDiscard?: () => void
	onRetry?: () => void
	actionsRef?: Ref<IslandBarActions>
	contained?: boolean
	announce?: boolean
	minSaving?: number
	savedFor?: number
}

const LABELS = {
	region: 'Unsaved changes',
	unsaved: 'Unsaved changes',
	saving: 'Saving…',
	saved: 'Saved',
	error: 'Couldn’t save your changes',
	save: 'Save',
	discard: 'Discard',
	retry: 'Try again',
	nudge: 'Save or discard your changes first.',
}

const VIEWS: View[] = ['dirty', 'saving', 'saved', 'error']

type CSSVariables = CSSProperties & Record<`--${string}`, string>

const { spring } = motionTokens
// The resting dot the island grows from and shrinks back into: one control row, a touch row on coarse pointers.
const DOT = { fine: 36, coarse: 44 }
// Keeps a 28px button at a 40px touch target without growing the island.
const TOUCH_TARGET = 'pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-1.5'
const noSubscribe = () => () => {}

export function IslandBar({
	status,
	message,
	icon,
	error,
	errorIcon,
	errorActions,
	extra,
	labels: labelOverrides,
	shortcut = 'mod+s',
	saveDisabled = false,
	onSave,
	onDiscard,
	onRetry,
	actionsRef,
	contained = false,
	announce = true,
	minSaving = 400,
	savedFor = 1400,
	className,
	ref,
	...props
}: IslandBarProps) {
	const labels = { ...LABELS, ...labelOverrides }
	const view = useHeldStatus(status, minSaving, savedFor)
	const leaving = useLeavingView(view)
	const mounted = useSyncExternalStore(
		noSubscribe,
		() => true,
		() => false,
	)
	const islandRef = useRef<HTMLDivElement>(null)
	const flashRef = useRef<HTMLSpanElement>(null)
	const sizes = useRef(new Map<string, { width: number; height: number }>())
	const shownView = useRef(view)
	const shownSize = useRef({ width: DOT.fine, height: DOT.fine })
	const observer = useRef<ResizeObserver>(null)
	const lastNudge = useRef(0)
	const enteringTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
	const width = useMotionValue(DOT.fine)
	const height = useMotionValue(DOT.fine)
	const shakeX = useMotionValue(0)
	const bumpScale = useMotionValue(1)
	const [live, setLive] = useState('')
	// The error layer keeps its last message while it fades out, after discard clears `error`.
	const [shownError, setShownError] = useState(error)
	if (status === 'error' && error !== shownError) setShownError(error)

	// The shell springs to the shown layer's size, as Arc's save bar does; hidden shrinks it back to the dot.
	const resize = useCallback(() => {
		const current = shownView.current
		const dot = matchMedia('(pointer: coarse)').matches ? DOT.coarse : DOT.fine
		const size = current === 'hidden' ? { width: dot, height: dot } : sizes.current.get(current)
		if (!size) return
		const next = { width: Math.ceil(size.width), height: Math.max(dot, Math.ceil(size.height)) }
		if (next.width === shownSize.current.width && next.height === shownSize.current.height) return
		shownSize.current = next
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
			width.jump(next.width)
			height.jump(next.height)
			return
		}
		const transition = current === 'hidden' ? spring.smooth : spring.morph
		animate(width, next.width, transition)
		animate(height, next.height, transition)
	}, [width, height])

	const observeLayer = useCallback(
		(node: HTMLDivElement | null) => {
			if (!node) return
			if (!observer.current)
				observer.current = new ResizeObserver(entries => {
					for (const entry of entries) {
						if (!(entry.target instanceof HTMLElement)) continue
						const layer = entry.target.dataset.layer
						if (!layer) continue
						const box = entry.borderBoxSize[0]
						if (!box) continue
						sizes.current.set(layer, { width: box.inlineSize, height: box.blockSize })
					}
					resize()
				})
			const current = observer.current
			current.observe(node)
			return () => current.unobserve(node)
		},
		[resize],
	)

	useEffect(
		() => () => {
			observer.current?.disconnect()
			clearTimeout(enteringTimer.current)
		},
		[],
	)

	useLayoutEffect(() => {
		const previous = shownView.current
		shownView.current = view
		const island = islandRef.current
		if (island && previous === 'hidden' && view !== 'hidden') {
			island.dataset.entering = ''
			clearTimeout(enteringTimer.current)
			enteringTimer.current = setTimeout(() => delete island.dataset.entering, 700)
		}
		if (island && previous !== view && island.contains(document.activeElement)) {
			const primary = island.querySelector<HTMLElement>(`[data-layer="${view}"] [data-island-primary]`)
			;(primary ?? island).focus({ preventScroll: true })
		}
		resize()
	}, [view, resize])

	const say = useCallback((text: string) => {
		setLive('')
		setTimeout(() => setLive(text), 30)
	}, [])

	useEffect(() => {
		if (status === 'saving') say(labels.saving)
		if (status === 'saved') say(labels.saved)
	}, [status, labels.saving, labels.saved, say])

	useImperativeHandle(
		actionsRef,
		() => ({
			nudge: ({ kind = 'bump', announce: speak = true, focus = false } = {}) => {
				if (speak && announce) say(labels.nudge)
				if (focus) {
					islandRef.current
						?.querySelector<HTMLElement>(`[data-layer="${shownView.current}"] [data-island-primary]`)
						?.focus({ preventScroll: true })
				}
				if (shownView.current === 'hidden') return
				const now = Date.now()
				if (now - lastNudge.current < 500) return
				lastNudge.current = now
				flashRef.current?.animate(
					{ opacity: [0, 1, 0, 1, 0], easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
					{ duration: 400 },
				)
				if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
				// Arc's settings page shakes its save bar with these offsets.
				if (kind === 'shake') animate(shakeX, [0, -7, 6, -4, 2, 0], { duration: 0.294, ease: 'easeOut' })
				else animate(bumpScale, [1, 1.04, 0.99, 1], { duration: 0.294, ease: 'easeOut' })
			},
		}),
		[announce, labels.nudge, say, shakeX, bumpScale],
	)

	const hidden = view === 'hidden'
	const keyshortcuts = ariaShortcut(shortcut)
	const errorText = typeof error === 'string' && error ? error : labels.error
	const layers = VIEWS.filter(layer => layer === view || layer === leaving)

	const primaryButton = (layer: View, active: boolean, label: string, onClick?: () => void) => (
		<span className='relative flex'>
			<Button
				size='sm'
				data-island-primary=''
				disabled={!active || saveDisabled}
				aria-keyshortcuts={keyshortcuts}
				onClick={onClick}
				className={TOUCH_TARGET}
			>
				{label}
				{shortcut && layer === 'dirty' ? <Kbd keys={shortcut} /> : null}
			</Button>
			<span
				ref={active ? flashRef : undefined}
				aria-hidden='true'
				className='pointer-events-none absolute -inset-0.5 rounded-[calc(var(--radius-control)+2px)] opacity-0 ring-2 ring-foreground/60'
			/>
		</span>
	)

	const discardButton = (active: boolean) =>
		onDiscard ? (
			<Button variant='ghost' size='sm' disabled={!active} onClick={onDiscard} className={TOUCH_TARGET}>
				{labels.discard}
			</Button>
		) : null

	const dock = (
		<div
			data-slot='island-bar-dock'
			className={cn(
				'@container pointer-events-none inset-x-0 z-40 flex flex-col items-center px-3 pb-3',
				// vexdock: a fixed bar stands on the shell's phone tab bar instead of under it.
				contained ? 'absolute bottom-0' : 'fixed bottom-(--tab-bar,0px) sm:pb-6',
			)}
		>
			<div
				ref={node => {
					islandRef.current = node
					if (typeof ref === 'function') return ref(node)
					if (ref) ref.current = node
				}}
				data-slot='island-bar'
				data-view={view}
				data-open={hidden ? undefined : ''}
				data-hidden={hidden ? '' : undefined}
				inert={hidden}
				role='region'
				aria-label={labels.region}
				tabIndex={-1}
				className={cn(
					'group/island pointer-events-auto relative flex max-w-full transition-transform duration-400 ease-spring [--island-base:40ms] data-entering:[--island-base:85ms] data-hidden:pointer-events-none data-hidden:delay-40 motion-safe:data-hidden:translate-y-5 motion-reduce:[--island-base:0ms] motion-safe:starting:translate-y-7',
					className,
				)}
				{...props}
			>
				<motion.div
					style={{ x: shakeX, scale: bumpScale }}
					className='group/body flex max-w-full transition-[opacity,filter] duration-170 ease-enter group-data-hidden/island:opacity-0 group-data-hidden/island:delay-70 group-data-hidden/island:duration-125 motion-safe:group-data-hidden/island:blur-xs starting:opacity-0 motion-safe:starting:blur-xs'
				>
					<motion.div
						style={{ width, height }}
						className='relative grid max-w-full grid-cols-1 place-items-center overflow-hidden rounded-full bg-surface-raised text-foreground shadow-floating ring ring-border forced-colors:border'
					>
						{layers.map(layer => {
							const active = layer === view
							const compact = layer === 'saving' || layer === 'saved'
							return (
								<div
									key={layer}
									ref={observeLayer}
									data-layer={layer}
									data-active={active ? '' : undefined}
									data-leaving={active ? undefined : ''}
									inert={!active}
									aria-hidden={active ? undefined : true}
									className={cn(
										'group/layer col-start-1 row-start-1 flex min-h-9 w-max max-w-[100cqw] items-center gap-2 py-1 text-sm font-medium pointer-coarse:min-h-11',
										compact ? 'px-3.5' : 'ps-3.5 pe-1 pointer-coarse:pe-2',
									)}
								>
									{layer === 'dirty' ? (
										<>
											<Stagger index={0} className='min-w-0 flex-1 gap-2'>
												{icon ? (
													<span aria-hidden='true' className='flex shrink-0'>
														{icon}
													</span>
												) : null}
												<Message>{message ?? labels.unsaved}</Message>
											</Stagger>
											{extra ? (
												<Stagger index={1} className='shrink-0'>
													{extra}
												</Stagger>
											) : null}
											<Stagger index={extra ? 2 : 1} className='shrink-0 gap-0.5'>
												{discardButton(active)}
												{primaryButton(layer, active, labels.save, onSave)}
											</Stagger>
										</>
									) : null}
									{layer === 'saving' ? (
										<>
											<Stagger index={0} className='shrink-0 text-muted'>
												<span
													aria-hidden='true'
													className='size-3.5 rounded-full border-[1.5px] border-current border-r-transparent [animation-duration:700ms] motion-safe:animate-spin'
												/>
											</Stagger>
											<Stagger index={1} className='whitespace-nowrap'>
												{labels.saving}
											</Stagger>
										</>
									) : null}
									{layer === 'saved' ? (
										<>
											<Stagger index={0} className='shrink-0'>
												<svg
													viewBox='0 0 24 24'
													aria-hidden='true'
													className='size-4.5 shrink-0 text-success'
												>
													<path
														d='M5 12.5 9.5 17 19 7.5'
														pathLength={1}
														fill='none'
														stroke='currentColor'
														strokeWidth={2}
														strokeLinecap='round'
														strokeLinejoin='round'
														className='transition-[stroke-dashoffset] delay-85 duration-280 ease-enter [stroke-dasharray:1] [stroke-dashoffset:0] motion-safe:starting:[stroke-dashoffset:1]'
													/>
												</svg>
											</Stagger>
											<Stagger index={1} className='whitespace-nowrap'>
												{labels.saved}
											</Stagger>
										</>
									) : null}
									{layer === 'error' ? (
										<>
											<Stagger index={0} className='min-w-0 flex-1 gap-2'>
												<span aria-hidden='true' className='flex shrink-0'>
													{errorIcon ?? (
														<IconAlertCircle
															size={16}
															stroke={1.75}
															className='text-danger'
														/>
													)}
												</span>
												<Message>{shownError ?? labels.error}</Message>
											</Stagger>
											{extra ? (
												<Stagger index={1} className='shrink-0'>
													{extra}
												</Stagger>
											) : null}
											<Stagger index={extra ? 2 : 1} className='shrink-0 gap-0.5'>
												{errorActions ?? (
													<>
														{discardButton(active)}
														{primaryButton(layer, active, labels.retry, onRetry ?? onSave)}
													</>
												)}
											</Stagger>
										</>
									) : null}
								</div>
							)
						})}
					</motion.div>
				</motion.div>
			</div>
			{contained ? null : <div aria-hidden='true' className='h-[env(safe-area-inset-bottom)] shrink-0' />}
			{announce ? (
				<>
					<div role='status' aria-live='polite' className='sr-only'>
						{live}
					</div>
					<div role='alert' className='sr-only'>
						{status === 'error' ? errorText : ''}
					</div>
				</>
			) : null}
		</div>
	)

	if (contained) return dock
	return mounted ? createPortal(dock, document.body) : null
}

// Holds Saving for at least minSaving and Saved for savedFor; a Saved that arrives without a save shows nothing.
function useHeldStatus(status: IslandBarStatus, minSaving: number, savedFor: number) {
	const [view, setView] = useState<IslandBarStatus>(() => (status === 'saved' ? 'hidden' : status))
	const [savedShown, setSavedShown] = useState(false)
	const since = useRef(0)
	if (savedShown && status !== 'saved') setSavedShown(false)
	const target = status === 'saved' && (view === 'saved' || savedShown) ? 'hidden' : status

	useLayoutEffect(() => {
		if (target === view) return
		const elapsed = Date.now() - since.current
		const wait =
			view === 'saving' && (target === 'saved' || target === 'error')
				? minSaving - elapsed
				: view === 'saved' && target === 'hidden'
					? savedFor - elapsed
					: 0
		const show = () => {
			since.current = Date.now()
			if (view === 'saved') setSavedShown(true)
			setView(target)
		}
		if (wait <= 0) {
			show()
			return
		}
		const timer = setTimeout(show, wait)
		return () => clearTimeout(timer)
	}, [target, view, minSaving, savedFor])

	return view
}

// The view that just left, kept mounted for 240ms so its content can fade out under the new one.
function useLeavingView(view: IslandBarStatus) {
	const [current, setCurrent] = useState(view)
	const [leaving, setLeaving] = useState<IslandBarStatus | null>(null)
	if (current !== view) {
		setCurrent(view)
		setLeaving(current === 'hidden' ? null : current)
	}
	useEffect(() => {
		if (!leaving) return
		const timer = setTimeout(() => setLeaving(null), 240)
		return () => clearTimeout(timer)
	}, [leaving])
	return leaving
}

function Stagger({ index, className, children }: { index: number; className?: string; children: ReactNode }) {
	const delay: CSSVariables = { '--island-delay': `calc(var(--island-base) + ${25 * index}ms)` }
	return (
		<span
			style={delay}
			className={cn(
				'flex items-center transition-[opacity,scale,filter] delay-(--island-delay) duration-170 ease-enter group-data-leaving/layer:opacity-0 group-data-leaving/layer:delay-0 group-data-leaving/layer:duration-125 motion-safe:group-data-leaving/layer:scale-96 motion-safe:group-data-leaving/layer:blur-xs motion-reduce:delay-0 starting:opacity-0 motion-safe:starting:scale-96 motion-safe:starting:blur-xs',
				className,
			)}
		>
			{children}
		</span>
	)
}

// A new message inside the same layer blurs in; the first one arrives with its layer.
function Message({ children }: { children: ReactNode }) {
	const first = useRef(children)
	return (
		<span
			key={typeof children === 'string' ? children : undefined}
			className={cn(
				'line-clamp-2 min-w-0 text-pretty',
				children !== first.current &&
					'transition-[opacity,filter,scale] duration-170 ease-enter starting:opacity-0 motion-safe:starting:scale-96 motion-safe:starting:blur-xs',
			)}
		>
			{children}
		</span>
	)
}

const KEY_NAMES: Record<string, { apple: string; other: string; spoken: string }> = {
	mod: { apple: '⌘', other: 'Ctrl', spoken: 'Command' },
	shift: { apple: '⇧', other: 'Shift', spoken: 'Shift' },
	alt: { apple: '⌥', other: 'Alt', spoken: 'Option' },
}

function Kbd({ keys }: { keys: string }) {
	const apple = useSyncExternalStore(
		noSubscribe,
		() => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent),
		() => true,
	)
	const parts = keys.split('+')
	const visible = parts.map(key => (KEY_NAMES[key] ? KEY_NAMES[key][apple ? 'apple' : 'other'] : key.toUpperCase()))
	const spoken = parts
		.map(key => (KEY_NAMES[key] ? (apple ? KEY_NAMES[key].spoken : 'Control') : key.toUpperCase()))
		.join(' ')
	return (
		<kbd
			data-slot='kbd'
			dir='ltr'
			className='inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[5px] bg-current/10 px-1 font-sans text-xs font-medium whitespace-nowrap tabular-nums inset-ring inset-ring-current/20 @max-md:hidden pointer-coarse:hidden'
		>
			<span aria-hidden='true'>{visible.join(apple ? '' : '+')}</span>
			<span className='sr-only'>{spoken}</span>
		</kbd>
	)
}

function ariaShortcut(shortcut: string | null) {
	const named = shortcut?.toLowerCase().startsWith('mod+') ? shortcut.slice(4) : ''
	if (!named) return
	const key = named.length === 1 ? named.toUpperCase() : named
	return `Meta+${key} Control+${key}`
}

function matchesShortcut(event: KeyboardEvent, shortcut: string) {
	const parts = shortcut.toLowerCase().split('+')
	const key = parts.at(-1)
	const apple = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
	const wantsMod = parts.includes('mod')
	const mod = apple ? event.metaKey : event.ctrlKey
	return (
		event.key.toLowerCase() === key &&
		mod === wantsMod &&
		event.shiftKey === parts.includes('shift') &&
		event.altKey === parts.includes('alt')
	)
}

type SavePhase = 'idle' | 'saving' | 'saved' | 'error'

export function useIslandBar({
	dirty,
	value,
	onSave,
	onDiscard,
	shortcut = 'mod+s',
	savedFor = 1800,
}: {
	dirty: boolean
	value: unknown
	onSave: () => unknown
	onDiscard?: () => void
	shortcut?: string | null
	savedFor?: number
}) {
	const [phase, setPhase] = useState<SavePhase>('idle')
	const [error, setError] = useState<string | null>(null)
	const [lastValue, setLastValue] = useState(value)
	const actionsRef = useRef<IslandBarActions>(null)
	const latest = useRef({ phase, onSave, onDiscard })
	const attempt = useRef(0)

	useLayoutEffect(() => {
		latest.current = { phase, onSave, onDiscard }
	})

	if (!Object.is(lastValue, value)) {
		setLastValue(value)
		if (phase === 'error' || phase === 'saved') {
			setPhase('idle')
			setError(null)
		}
	}

	useEffect(() => {
		if (phase !== 'saved') return
		const timer = setTimeout(() => setPhase('idle'), savedFor)
		return () => clearTimeout(timer)
	}, [phase, savedFor])

	const save = useCallback(async () => {
		if (latest.current.phase === 'saving') return
		const id = ++attempt.current
		setPhase('saving')
		setError(null)
		try {
			await latest.current.onSave()
			if (id === attempt.current) setPhase('saved')
		} catch (error_) {
			if (id !== attempt.current) return
			setError(
				error_ instanceof Error && error_.message
					? `Couldn’t save. ${error_.message}`
					: 'Couldn’t save your changes. Try again.',
			)
			setPhase('error')
		}
	}, [])

	const discard = useCallback(() => {
		if (latest.current.phase === 'saving') return
		latest.current.onDiscard?.()
		setPhase('idle')
		setError(null)
	}, [])

	const reset = useCallback(() => {
		attempt.current++
		setPhase('idle')
		setError(null)
	}, [])

	const nudge = useCallback((options?: IslandBarNudge) => actionsRef.current?.nudge(options), [])

	const status: IslandBarStatus =
		phase === 'saving'
			? 'saving'
			: phase === 'error'
				? 'error'
				: dirty
					? 'dirty'
					: phase === 'saved'
						? 'saved'
						: 'hidden'
	const blocked = status === 'dirty' || status === 'saving' || status === 'error'

	const guard = useCallback(
		(options?: IslandBarNudge) => {
			if (!blocked) return false
			actionsRef.current?.nudge(options)
			return true
		},
		[blocked],
	)

	useEffect(() => {
		if (!shortcut || (status !== 'dirty' && status !== 'error')) return
		const onKey = (event: KeyboardEvent) => {
			if (!matchesShortcut(event, shortcut)) return
			event.preventDefault()
			void save()
		}
		document.addEventListener('keydown', onKey)
		return () => document.removeEventListener('keydown', onKey)
	}, [shortcut, status, save])

	useEffect(() => {
		if (!blocked) return
		const onLeave = (event: BeforeUnloadEvent) => {
			event.preventDefault()
			event.returnValue = ''
		}
		window.addEventListener('beforeunload', onLeave)
		return () => window.removeEventListener('beforeunload', onLeave)
	}, [blocked])

	return {
		status,
		error,
		blocked,
		save,
		discard,
		reset,
		nudge,
		guard,
		actionsRef,
		props: {
			status,
			error: error ?? undefined,
			shortcut,
			actionsRef,
			onSave: () => void save(),
			onRetry: () => void save(),
			onDiscard: onDiscard ? discard : undefined,
		},
	}
}
