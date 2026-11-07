import {
	type KeyboardEvent,
	type PointerEvent,
	type Ref,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'
import { Toggle } from '@base-ui/react/toggle'
import { cn } from 'cn'
import {
	AnimatePresence,
	animate,
	type MotionValue,
	motion,
	useInView,
	useMotionValue,
	useMotionValueEvent,
	useReducedMotion,
	useSpring,
	useTransform,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type LineChartSeries = {
	key: string
	label: string
	color?: string
	dashed?: boolean
	area?: boolean
}

export type LineChartDatum = {
	key: string
	label: string
	axisLabel?: string
	values: Record<string, number | undefined>
}

type LineChartProps = {
	data: readonly LineChartDatum[]
	series: readonly LineChartSeries[]
	label: string
	unit?: string
	height?: number
	formatValue?: (value: number, series: LineChartSeries) => string
	formatTick?: (value: number) => string
	hiddenSeries?: readonly string[]
	defaultHiddenSeries?: readonly string[]
	onHiddenSeriesChange?: (hidden: string[]) => void
	onActiveChange?: (index: number | null, datum: LineChartDatum | null) => void
	loading?: boolean
	emptyLabel?: string
	legend?: boolean
	categoryLabel?: string
	curve?: 'smooth' | 'linear'
	ref?: Ref<HTMLElement>
	className?: string
	// vexdock: lowest ceiling for the scale, so an idle byte rate gets 0..1 KiB ticks instead of 0..1 B, which bytes() rounds to duplicates.
	max?: number
	// vexdock: steps a byte axis in KiB, MiB or GiB, so bytes() prints 5 MB where a decimal step would print 4.8 MB.
	binary?: boolean
	// vexdock: a crosshair shared across small multiples; this chart still reports its own through onActiveChange.
	activeIndex?: number | null
}

type Point = [x: number, value: number]
type Track = { shape: Point[]; presence: number; fade: { stop: () => void } | null }
type Scale = { min: MotionValue<number>; max: MotionValue<number> }

const { spring, duration, ease } = motionTokens
// Motion drops inherited velocity on time-defined springs, so values that retarget mid-flight run the same springs as stiffness and damping.
const settle = physical(spring.smooth)
const glide = physical(spring.snappy, 0.0001)
const follow = { stiffness: glide.stiffness, damping: glide.damping, restDelta: 0.01 }
const draw = { duration: duration.considered * 1.75, ease: ease.inOut }
const fadeIn = { duration: duration.standard, ease: ease.standard }
const fadeOut = { opacity: 0, transition: { duration: duration.instant, ease: ease.standard } }
// Arc's 1.4s loading pulse at 0.7x.
const breathe = {
	duration: 0.98,
	ease: ease.inOut,
	repeat: Infinity,
	repeatType: 'reverse' as const,
}

// Room above the top gridline, and the gap between the crosshair and its tooltip, in pixels.
const TOP = 12
const GAP = 14
const PALETTE = [
	'var(--accent)',
	'color-mix(in oklab, var(--foreground) 46%, var(--surface))',
	'color-mix(in oklab, var(--foreground) 26%, var(--surface))',
]
// Shared x positions a morph samples both shapes on, so a range that gains or loses points still flows.
const GRID = Array.from({ length: 241 }, (_, index) => index / 240)
const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export function LineChart({
	data,
	series,
	label,
	unit = '',
	height = 220,
	formatValue,
	formatTick = compact.format,
	hiddenSeries,
	defaultHiddenSeries = [],
	onHiddenSeriesChange,
	onActiveChange,
	loading = false,
	emptyLabel = 'No data for this range',
	legend,
	categoryLabel = 'Date',
	curve = 'smooth',
	ref,
	className,
	max = 0,
	binary = false,
	activeIndex,
}: LineChartProps) {
	const reduced = useReducedMotion() ?? false
	const chart = useRef<HTMLDivElement>(null)
	const plot = useRef<HTMLDivElement>(null)
	const tip = useRef<HTMLDivElement>(null)
	const clip = useRef<SVGRectElement>(null)
	const crosshair = useRef<SVGLineElement>(null)
	const lines = useRef(new Map<string, SVGPathElement>())
	const areas = useRef(new Map<string, SVGPathElement>())
	const dots = useRef(new Map<string, SVGCircleElement>())
	const groups = useRef(new Map<string, SVGGElement>())
	const inView = useInView(chart, { once: true, amount: 0.3 })
	const clipId = `line${useId().replace(/[^\w-]/g, '')}`
	const last = data.length - 1
	const empty = data.length === 0

	const [ownHidden, setOwnHidden] = useState(defaultHiddenSeries)
	const hidden = hiddenSeries ?? ownHidden
	const visible = series.filter(line => !hidden.includes(line.key))
	const showLegend = legend ?? series.length > 1

	// The scale fits only the series on show.
	let low = Infinity
	let high = -Infinity
	for (const line of visible) {
		for (const item of data) {
			const value = item.values[line.key] ?? 0
			low = Math.min(low, value)
			high = Math.max(high, value)
		}
	}
	const range = Number.isFinite(low) ? (binary ? binaryScale : niceScale)(low, Math.max(high, max)) : null
	const [steady, setSteady] = useState(() => range ?? niceScale(0, 100))
	if (range && (range.min !== steady.min || range.max !== steady.max)) setSteady(range)
	const scale = { min: useMotionValue(steady.min), max: useMotionValue(steady.max) }

	const signature = `${curve}|${series.map(line => line.key).join(',')}|${data
		.map(item => `${item.key}:${series.map(line => item.values[line.key] ?? 0).join(',')}`)
		.join(';')}`

	// A new range lets go of the crosshair.
	const [active, setActive] = useState<number | null>(null)
	const [seenSignature, setSeenSignature] = useState(signature)
	if (seenSignature !== signature) {
		setSeenSignature(signature)
		setActive(null)
	}
	const own = active === null || empty ? null : Math.min(active, last)
	const shared = activeIndex === undefined ? own : activeIndex
	const index = shared === null || empty ? null : Math.min(shared, last)
	const scrubbing = index !== null

	const width = useRef(0)
	const [plotWidth, setPlotWidth] = useState(0)
	const tipSize = useRef({ width: 0, height: 0 })
	const tracks = useRef(new Map<string, Track>())
	const drawn = useMotionValue(0)
	const cursor = useMotionValue(1)
	const tipTargetX = useMotionValue(0)
	const tipTargetY = useMotionValue(0)
	const tipSpringX = useSpring(tipTargetX, follow)
	const tipSpringY = useSpring(tipTargetY, follow)

	// One writer for every drawn attribute: morphs, toggles, the scale, the crosshair and the measured size repaint here.
	const paint = useCallback(() => {
		const w = width.current
		if (!w) return
		const lo = scale.min.get()
		const span = scale.max.get() - lo || 1
		const toY = (value: number) => TOP + (1 - (value - lo) / span) * (height - TOP)
		const at = cursor.get()
		const dotYs: number[] = []
		for (const [key, track] of tracks.current) {
			const flatten = (value: number) => toY(lo + (value - lo) * track.presence)
			const path = track.shape.length
				? `M${track.shape.map(([x, value]) => `${(x * w).toFixed(1)},${flatten(value).toFixed(1)}`).join('L')}`
				: ''
			lines.current.get(key)?.setAttribute('d', path)
			areas.current.get(key)?.setAttribute('d', path && `${path}L${w},${height}L0,${height}Z`)
			groups.current.get(key)?.setAttribute('opacity', String(track.presence))
			const dot = dots.current.get(key)
			if (!dot || !track.shape.length) continue
			const cy = flatten(valueAt(track.shape, at))
			dot.setAttribute('cx', (at * w).toFixed(1))
			dot.setAttribute('cy', cy.toFixed(1))
			if (track.presence > 0.5) dotYs.push(cy)
		}
		clip.current?.setAttribute('width', String(drawn.get() * (w + 16)))
		const cx = Math.round(at * w) + 0.5
		crosshair.current?.setAttribute('x1', String(cx))
		crosshair.current?.setAttribute('x2', String(cx))
		// The tooltip sits beside the crosshair, flips sides before it would leave the plot, and centres on its points.
		const size = tipSize.current
		const beside = cx + GAP + size.width > w ? cx - GAP - size.width : cx + GAP
		const middle = dotYs.length ? dotYs.reduce((sum, y) => sum + y, 0) / dotYs.length : height / 2
		tipTargetX.set(clamp(beside, 0, Math.max(0, w - size.width)))
		tipTargetY.set(clamp(middle - size.height / 2, 0, Math.max(0, height - size.height)))
	}, [cursor, drawn, height, scale.max, scale.min, tipTargetX, tipTargetY])
	useMotionValueEvent(cursor, 'change', paint)
	useMotionValueEvent(drawn, 'change', paint)
	useMotionValueEvent(scale.min, 'change', paint)
	useMotionValueEvent(scale.max, 'change', paint)
	useLayoutEffect(paint)

	// The plot draws in its own pixels: measure the width, follow resizes, and size the tooltip for its flip.
	useLayoutEffect(() => {
		const node = plot.current
		const bubble = tip.current
		if (!node || !bubble) return
		const read = () => {
			width.current = node.clientWidth
			tipSize.current = { width: bubble.offsetWidth, height: bubble.offsetHeight }
			setPlotWidth(node.clientWidth)
			paint()
		}
		read()
		const observer = new ResizeObserver(read)
		observer.observe(node)
		observer.observe(bubble)
		return () => observer.disconnect()
	}, [paint])

	// New data morphs every line from the shape on screen. signature stands in for data, series and curve.
	useEffect(() => {
		const moves: { track: Track; xs: number[]; from: number[]; to: number[]; target: Point[] }[] = []
		for (const line of series) {
			const target = curveFor(
				data.map(item => item.values[line.key] ?? 0),
				curve === 'smooth',
			)
			const track = tracks.current.get(line.key)
			if (!track) {
				tracks.current.set(line.key, {
					shape: target,
					presence: hidden.includes(line.key) ? 0 : 1,
					fade: null,
				})
				continue
			}
			if (!track.shape.length || !target.length || reduced) {
				track.shape = target
				continue
			}
			const xs = [...new Set([...GRID, ...target.map(([x]) => x)])].sort((a, b) => a - b)
			const from = xs.map(x => valueAt(track.shape, x))
			const to = xs.map(x => valueAt(target, x))
			moves.push({ track, xs, from, to, target })
		}
		paint()
		if (!moves.length) return
		const morph = animate(0, 1, {
			...settle,
			restDelta: 0.0005,
			onUpdate: progress => {
				for (const move of moves) {
					move.track.shape = move.xs.map((x, at): Point => [x, mix(move.from[at]!, move.to[at]!, progress)])
				}
				paint()
			},
			onComplete: () => {
				for (const move of moves) move.track.shape = move.target
				paint()
			},
		})
		return () => morph.stop()
	}, [signature, paint, reduced])

	// A hidden series flattens into the baseline as it fades; the ones that stay rescale around it.
	const hiddenSignature = hidden.join('|')
	useEffect(() => {
		for (const [key, track] of tracks.current) {
			const to = hidden.includes(key) ? 0 : 1
			if (track.presence === to) continue
			track.fade?.stop()
			if (reduced) {
				track.presence = to
				continue
			}
			track.fade = animate(track.presence, to, {
				...settle,
				onUpdate: presence => {
					track.presence = presence
					paint()
				},
			})
		}
		paint()
	}, [hiddenSignature, paint, reduced])

	// The value scale springs to its new range while gridlines ride along.
	useEffect(() => {
		if (reduced) {
			scale.min.jump(steady.min)
			scale.max.jump(steady.max)
			return
		}
		const controls = [animate(scale.min, steady.min, settle), animate(scale.max, steady.max, settle)]
		return () => {
			for (const control of controls) control.stop()
		}
	}, [reduced, scale.max, scale.min, steady])

	// The lines draw left to right the first time the chart is seen with data.
	useEffect(() => {
		if (empty) return
		if (reduced) {
			drawn.jump(1)
			return
		}
		if (!inView || drawn.get() >= 1) return
		const controls = animate(drawn, 1, draw)
		return () => controls.stop()
	}, [drawn, empty, inView, reduced])

	// The crosshair appears on the first scrubbed point and glides between the ones after it; the tooltip follows on its own spring.
	const wasScrubbing = useRef(false)
	useEffect(() => {
		if (index === null) {
			wasScrubbing.current = false
			return
		}
		const to = last > 0 ? index / last : 0.5
		if (reduced || !wasScrubbing.current) {
			cursor.jump(to)
			tipSpringX.jump(tipTargetX.get())
			tipSpringY.jump(tipTargetY.get())
		}
		wasScrubbing.current = true
		if (reduced) return
		const controls = animate(cursor, to, glide)
		return () => controls.stop()
	}, [cursor, index, last, reduced, tipSpringX, tipSpringY, tipTargetX, tipTargetY])

	// The series dim and pulse while the next range loads; cancel hands opacity back to the class, which fades it up. Reduced motion keeps them dimmed and still.
	useEffect(() => {
		const node = chart.current?.querySelector('[data-series]')
		if (!loading || reduced || !node) return
		const pulse = animate(node, { opacity: [0.22, 0.45] }, breathe)
		return () => pulse.cancel()
	}, [loading, reduced])

	const onActive = useRef(onActiveChange)
	useLayoutEffect(() => {
		onActive.current = onActiveChange
	})
	useEffect(() => {
		onActive.current?.(own, own === null ? null : data[own]!)
	}, [own])

	function toggle(key: string) {
		const next = hidden.includes(key) ? hidden.filter(item => item !== key) : [...hidden, key]
		if (hiddenSeries === undefined) setOwnHidden(next)
		onHiddenSeriesChange?.(next)
	}

	function pointAt(clientX: number) {
		const box = plot.current?.getBoundingClientRect()
		if (!box?.width || last < 1) return Math.max(0, last)
		return clamp(Math.round(((clientX - box.left) / box.width) * last), 0, last)
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === 'Escape' && scrubbing) {
			event.preventDefault()
			setActive(null)
			return
		}
		const next = stepTo(event.key, index, last, Math.max(1, Math.round(data.length / 6)))
		if (next === undefined || empty) return
		event.preventDefault()
		setActive(clamp(next, 0, last))
	}

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		if (empty) return
		if (event.pointerType !== 'mouse') event.currentTarget.setPointerCapture(event.pointerId)
		setActive(pointAt(event.clientX))
	}

	function onPointerMove(event: PointerEvent<HTMLDivElement>) {
		if (!empty && (event.pointerType === 'mouse' || event.buttons)) {
			setActive(pointAt(event.clientX))
		}
	}

	const format = (value: number, line: LineChartSeries) =>
		`${formatValue ? formatValue(value, line) : grouped.format(value)}${unit ? ` ${unit}` : ''}`
	const reading = index === null ? null : data[index]
	const shown = reading ?? data.at(-1)
	const valueText = reading
		? `${reading.label}: ${visible.map(line => `${line.label} ${format(reading.values[line.key] ?? 0, line)}`).join(', ')}`
		: empty
			? emptyLabel
			: `${visible.length} of ${series.length} series shown`
	const summary = empty
		? `${label}. ${emptyLabel}.`
		: `${label}, ${data[0]!.label} to ${data[last]!.label}. ${visible
				.map(line => `${line.label}, latest ${format(data[last]!.values[line.key] ?? 0, line)}`)
				.join('. ')}.`
	const picks = axisPicks(data, plotWidth)
	const allHidden = !empty && visible.length === 0
	const tipX = reduced ? tipTargetX : tipSpringX
	const tipY = reduced ? tipTargetY : tipSpringY

	return (
		<figure
			ref={ref}
			aria-label={label}
			aria-busy={loading || undefined}
			className={cn('m-0 grid min-w-0 gap-3 text-foreground', className)}
		>
			{showLegend && (
				<div
					role='group'
					aria-label={`${label} series`}
					className='-mx-2 flex min-w-0 flex-wrap gap-x-1 gap-y-0.5'
				>
					{series.map((line, at) => (
						<Toggle
							key={line.key}
							pressed={!hidden.includes(line.key)}
							onPressedChange={() => toggle(line.key)}
							className='group/toggle inline-flex min-h-8 items-center gap-2 rounded-full pr-2.5 pl-2 text-sm text-secondary [transition:color_110ms_var(--ease-standard),background-color_110ms_var(--ease-standard),scale_85ms_var(--ease-standard)] not-data-pressed:text-muted hover:bg-surface-muted hover:text-foreground active:scale-97'
						>
							<span aria-hidden className='relative h-2.5 w-3.5 flex-none'>
								<Swatch
									color={colorOf(line, at)}
									length={14}
									dash={line.dashed ? '4 3' : undefined}
									className='absolute top-1/2 left-0 w-full origin-left -translate-y-1/2 [transition:scale_170ms_var(--ease-spring),opacity_110ms_var(--ease-standard)] group-not-data-pressed/toggle:scale-x-35 group-not-data-pressed/toggle:opacity-45'
								/>
							</span>
							<span className='whitespace-nowrap decoration-current/55 transition-opacity group-not-data-pressed/toggle:line-through group-not-data-pressed/toggle:opacity-72'>
								{line.label}
							</span>
						</Toggle>
					))}
				</div>
			)}

			<div
				ref={chart}
				data-scrubbing={scrubbing || undefined}
				data-loading={loading || undefined}
				className='group/chart relative grid min-w-0 grid-cols-[minmax(0,1fr)_48px] grid-rows-[auto_26px]'
			>
				<div
					ref={plot}
					role='slider'
					tabIndex={empty ? -1 : 0}
					aria-label={`${label}, explore by ${categoryLabel.toLowerCase()}`}
					aria-orientation='horizontal'
					aria-valuemin={1}
					aria-valuemax={Math.max(1, data.length)}
					aria-valuenow={(index ?? last) + 1}
					aria-valuetext={valueText}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={event => {
						if (event.pointerType !== 'mouse') setActive(null)
					}}
					onPointerCancel={() => setActive(null)}
					onPointerLeave={event => {
						if (event.pointerType === 'mouse') setActive(null)
					}}
					onKeyDown={onKeyDown}
					onBlur={() => setActive(null)}
					onFocus={event => {
						if (event.currentTarget.matches(':focus-visible') && !empty) {
							setActive(current => current ?? last)
						}
					}}
					className='relative col-start-1 row-start-1 min-w-0 touch-pan-y select-none'
					style={{ height }}
				>
					<svg width='100%' height={height} aria-hidden focusable='false' className='block overflow-visible'>
						<defs>
							<clipPath id={clipId} clipPathUnits='userSpaceOnUse'>
								<rect ref={clip} x={-8} y={-16} width={0} height={height + 32} />
							</clipPath>
						</defs>
						<AnimatePresence initial={false}>
							{steady.ticks.slice(1).map(value => (
								<Gridline key={value} value={value} scale={scale} height={height} />
							))}
						</AnimatePresence>
						<line
							x1={0}
							x2='100%'
							y1={height - 0.5}
							y2={height - 0.5}
							className='stroke-border-strong [shape-rendering:crispEdges]'
						/>
						<line
							ref={crosshair}
							y1={TOP - 4}
							y2={height}
							className='stroke-border-strong opacity-0 transition-opacity duration-85 [shape-rendering:crispEdges] group-data-scrubbing/chart:opacity-100'
						/>
						<g
							data-series
							clipPath={`url(#${clipId})`}
							className='transition-opacity duration-170 group-data-loading/chart:opacity-32'
						>
							{series.map((line, at) => (
								<g
									key={line.key}
									ref={node => {
										if (!node) return
										groups.current.set(line.key, node)
										return () => {
											groups.current.delete(line.key)
										}
									}}
								>
									{(line.area ?? at === 0) && (
										<path
											ref={node => {
												if (!node) return
												areas.current.set(line.key, node)
												return () => {
													areas.current.delete(line.key)
												}
											}}
											style={{
												fill: `color-mix(in oklab, ${colorOf(line, at)} 9%, transparent)`,
											}}
										/>
									)}
									<path
										ref={node => {
											if (!node) return
											lines.current.set(line.key, node)
											return () => {
												lines.current.delete(line.key)
											}
										}}
										fill='none'
										strokeWidth={line.dashed ? 1.75 : 2}
										strokeDasharray={line.dashed ? '4 5' : undefined}
										strokeLinecap='round'
										strokeLinejoin='round'
										className='transition-[stroke] duration-170'
										style={{ stroke: colorOf(line, at) }}
									/>
								</g>
							))}
						</g>
						{series.map((line, at) => (
							<circle
								key={line.key}
								ref={node => {
									if (!node) return
									dots.current.set(line.key, node)
									return () => {
										dots.current.delete(line.key)
									}
								}}
								r={4}
								strokeWidth={2}
								data-hidden={hidden.includes(line.key) || undefined}
								className='stroke-surface opacity-0 transition-opacity duration-85 group-data-scrubbing/chart:not-data-hidden:opacity-100'
								style={{ fill: colorOf(line, at) }}
							/>
						))}
					</svg>
					<motion.div
						ref={tip}
						aria-hidden
						style={{ x: tipX, y: tipY }}
						className='pointer-events-none absolute top-0 left-0 z-1 grid max-w-[min(220px,100%)] min-w-35 scale-96 gap-1 rounded-panel border bg-surface-raised px-3 py-2.5 opacity-0 shadow-floating transition-[opacity,scale] group-data-scrubbing/chart:scale-100 group-data-scrubbing/chart:opacity-100'
					>
						<p className='mb-0.5 text-xs whitespace-nowrap text-secondary tabular-nums'>{shown?.label}</p>
						{visible.map(line => (
							<p key={line.key} className='flex min-w-0 items-center gap-2 text-sm'>
								<Swatch
									color={colorOf(line, series.indexOf(line))}
									length={10}
									dash={line.dashed ? '3 2' : undefined}
									className='w-2.5'
								/>
								<span className='min-w-0 flex-1 truncate text-secondary'>{line.label}</span>
								<span className='ml-2 flex-none font-medium whitespace-nowrap tabular-nums'>
									{format(shown?.values[line.key] ?? 0, line)}
								</span>
							</p>
						))}
					</motion.div>
					<AnimatePresence initial={false}>
						{(empty || allHidden) && !loading && (
							<motion.p
								key={empty ? 'empty' : 'hidden'}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={fadeOut}
								className='pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted'
							>
								{empty ? emptyLabel : 'Choose a series to show'}
							</motion.p>
						)}
					</AnimatePresence>
					{loading && empty && (
						<motion.span
							aria-hidden
							animate={reduced ? undefined : { opacity: [0.22, 0.45] }}
							transition={breathe}
							className='absolute inset-x-0 top-[30%] bottom-[25%] rounded-control bg-foreground/5 [mask-image:linear-gradient(to_bottom,transparent,black)]'
						/>
					)}
				</div>
				<div aria-hidden className='relative col-start-2 row-start-1 min-w-0'>
					<AnimatePresence initial={false}>
						{steady.ticks.map(value => (
							<TickLabel key={value} value={value} scale={scale} height={height} format={formatTick} />
						))}
					</AnimatePresence>
				</div>
				<div aria-hidden className='relative col-start-1 row-start-2 min-w-0'>
					<AnimatePresence initial={false}>
						{picks.map(at => {
							const share = last > 0 ? at / last : 0.5
							return (
								<motion.span
									key={`${data[at]!.key}:${data[at]!.axisLabel}`}
									initial={{ opacity: 0 }}
									animate={{ opacity: 1 }}
									exit={fadeOut}
									transition={fadeIn}
									style={{ left: `${share * 100}%`, x: `${-share * 100}%` }}
									className='absolute top-2 text-xs leading-none whitespace-nowrap text-muted tabular-nums'
								>
									{data[at]!.axisLabel}
								</motion.span>
							)
						})}
					</AnimatePresence>
				</div>
			</div>

			<p className='sr-only'>{summary}</p>
			{!empty && (
				<div className='sr-only'>
					<table>
						<caption>{label}</caption>
						<thead>
							<tr>
								<th scope='col'>{categoryLabel}</th>
								{series.map(line => (
									<th key={line.key} scope='col'>
										{line.label}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{data.map(item => (
								<tr key={item.key}>
									<th scope='row'>{item.label}</th>
									{series.map(line => (
										<td key={line.key}>{format(item.values[line.key] ?? 0, line)}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			<p aria-live='polite' aria-atomic='true' className='sr-only'>
				{loading ? 'Loading' : ''}
			</p>
		</figure>
	)
}

// A gridline rides the scale, so a taller range slides it down while new rows fade in above.
function Gridline({ value, scale, height }: { value: number; scale: Scale; height: number }) {
	const y = useRowY(value, scale, height)
	return (
		<motion.line
			x1={0}
			x2='100%'
			y1={y}
			y2={y}
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={fadeOut}
			transition={fadeIn}
			className='stroke-border [shape-rendering:crispEdges]'
		/>
	)
}

function TickLabel({
	value,
	scale,
	height,
	format,
}: {
	value: number
	scale: Scale
	height: number
	format: (value: number) => string
}) {
	const y = useRowY(value, scale, height)
	return (
		<motion.span
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={fadeOut}
			transition={fadeIn}
			style={{ y }}
			className='pointer-events-none absolute top-0 left-2.5 block h-0 whitespace-nowrap'
		>
			<span className='block -translate-y-1/2 text-xs leading-none text-muted tabular-nums'>{format(value)}</span>
		</motion.span>
	)
}

function useRowY(value: number, scale: Scale, height: number) {
	return useTransform(() => {
		const span = scale.max.get() - scale.min.get() || 1
		return Math.round(TOP + (1 - (value - scale.min.get()) / span) * (height - TOP)) + 0.5
	})
}

// A line swatch with square dashes and rounded outer ends, matching Arc's legend mark.
function Swatch({
	color,
	length,
	dash,
	className,
}: {
	color: string
	length: number
	dash?: string
	className: string
}) {
	return (
		<svg
			viewBox={`0 0 ${length} 2.5`}
			preserveAspectRatio='none'
			aria-hidden
			className={cn('block h-[2.5px] flex-none rounded-[2px]', className)}
		>
			<line
				x1={0}
				x2={length}
				y1={1.25}
				y2={1.25}
				strokeWidth={2.5}
				strokeDasharray={dash}
				style={{ stroke: color }}
			/>
		</svg>
	)
}

// Clean gridlines: the smallest step of 1, 2, 2.5 or 5 that covers the data in four rows or fewer, from zero unless the data dips below it.
function niceScale(low: number, high: number) {
	const lo = Math.min(0, low)
	const hi = Math.max(high, lo + 1)
	const magnitude = 10 ** Math.floor(Math.log10((hi - lo) / 4))
	for (const factor of [1, 2, 2.5, 5, 10]) {
		const step = factor * magnitude
		const bottom = Math.floor(lo / step) * step
		const top = Math.ceil(hi / step) * step
		if ((top - bottom) / step > 4 + 1e-9) continue
		const ticks: number[] = []
		for (let value = bottom; value <= top + step / 2; value += step) ticks.push(clean(value))
		return { min: clean(bottom), max: clean(top), ticks }
	}
	return { min: lo, max: hi, ticks: [lo, hi] }
}

// vexdock: niceScale counted in B, KiB, MiB or GiB, the first whose rounded top stays under 1000, scaled back to bytes.
// The top, not the data: 999 KiB rounds up to a 1000 KiB tick, which would print as "1000 KB".
export function binaryScale(low: number, high: number) {
	let unit = 1
	let range = niceScale(low, high)
	while (range.max >= 1000) {
		unit *= 1024
		range = niceScale(low / unit, high / unit)
	}
	return { min: range.min * unit, max: range.max * unit, ticks: range.ticks.map(tick => tick * unit) }
}

// The line through every value, sampled on x from 0 to 1. Monotone cubic tangents keep a smooth curve from swinging past the data.
function curveFor(values: number[], smooth: boolean): Point[] {
	if (values.length === 0) return []
	if (values.length === 1)
		return [
			[0, values[0]!],
			[1, values[0]!],
		]
	const last = values.length - 1
	const step = 1 / last
	if (!smooth) return values.map((value, index) => [index * step, value])
	const slopes = values.slice(1).map((value, index) => (value - values[index]!) / step)
	const tangents = values.map((_, index) => {
		if (index === 0 || index === last) return 0
		const before = slopes[index - 1]!
		const after = slopes[index]!
		const size = Math.min(Math.abs(before), Math.abs(after), Math.abs(before + after) / 4)
		return (Math.sign(before) + Math.sign(after)) * size
	})
	if (last > 1) {
		tangents[0] = (3 * slopes[0]! - tangents[1]!) / 2
		tangents[last] = (3 * slopes[last - 1]! - tangents[last - 1]!) / 2
	} else {
		tangents[0] = slopes[0]!
		tangents[1] = slopes[0]!
	}
	const samples = Math.max(1, Math.min(16, Math.round(192 / last)))
	const points: Point[] = []
	for (let index = 0; index < last; index++) {
		const start = values[index]!
		const end = values[index + 1]!
		for (let sample = 0; sample < samples; sample++) {
			const t = sample / samples
			const t2 = t * t
			const t3 = t2 * t
			const value =
				(2 * t3 - 3 * t2 + 1) * start +
				(t3 - 2 * t2 + t) * step * tangents[index]! +
				(3 * t2 - 2 * t3) * end +
				(t3 - t2) * step * tangents[index + 1]!
			points.push([(index + t) * step, clamp(value, Math.min(start, end), Math.max(start, end))])
		}
	}
	points.push([1, values[last]!])
	return points
}

// Value of a sampled line at x, straight between samples.
function valueAt(shape: Point[], x: number) {
	let low = 0
	let high = shape.length - 1
	if (x <= shape[low]![0]) return shape[low]![1]
	if (x >= shape[high]![0]) return shape[high]![1]
	while (high - low > 1) {
		const middle = (low + high) >> 1
		if (shape[middle]![0] < x) low = middle
		else high = middle
	}
	const [x0, y0] = shape[low]!
	const [x1, y1] = shape[high]!
	return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
}

// Axis labels that fit: at most one per 76 pixels, counted back from the latest so the newest date always shows.
function axisPicks(data: readonly LineChartDatum[], width: number) {
	const labeled = data.flatMap((item, index) => (item.axisLabel ? [index] : []))
	if (!width || !labeled.length) return []
	const stride = Math.ceil(labeled.length / Math.max(2, Math.floor(width / 76)))
	return labeled
		.reverse()
		.filter((_, rank) => rank % stride === 0)
		.reverse()
}

function stepTo(key: string, index: number | null, last: number, page: number) {
	const from = index ?? last + 1
	switch (key) {
		case 'ArrowLeft':
		case 'ArrowDown':
			return from - 1
		case 'ArrowRight':
		case 'ArrowUp':
			return index === null ? last : from + 1
		case 'PageDown':
			return from - page
		case 'PageUp':
			return from + page
		case 'Home':
			return 0
		case 'End':
			return last
	}
	return undefined
}

// Time-defined springs written as stiffness and damping, so they keep inherited velocity.
function physical({ visualDuration, bounce }: { visualDuration: number; bounce: number }, restDelta = 0.001) {
	const root = (2 * Math.PI) / (visualDuration * 1.2)
	return {
		type: 'spring' as const,
		stiffness: root * root,
		damping: 2 * (1 - bounce) * root,
		restDelta,
		restSpeed: restDelta * 2,
	}
}

function colorOf(line: LineChartSeries, index: number) {
	return line.color ?? PALETTE[Math.min(index, PALETTE.length - 1)]!
}

function clean(value: number) {
	return Number(value.toPrecision(12))
}

function mix(from: number, to: number, progress: number) {
	return from + (to - from) * progress
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max)
}
