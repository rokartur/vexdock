'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from 'motion/react'
import type { TargetAndTransition } from 'motion/react'
import { motionTokens } from './motion-tokens'
import { exitFast, fadeOut, iconIn, iconKey } from './swap'

export interface ButtonGroupItem {
	/** Stable key for the segment. */
	id: string
	/** The accessible name and tooltip. */
	label: string
	icon: ReactNode
	onSelect?: () => void
	/** Makes the segment a toggle (follow, wrap) and draws it held down while true. */
	pressed?: boolean
}

export interface ButtonGroupProps {
	items: ButtonGroupItem[]
	/** Accessible name of the group, such as "Log actions". */
	label: string
}

const rest: TargetAndTransition = { opacity: 1, scale: 1, filter: 'blur(0px)' }
const iconOut: TargetAndTransition = { ...iconIn, transition: exitFast }

const inside = (node: HTMLElement, x: number, y: number) => {
	const rect = node.getBoundingClientRect()
	return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
}
/** Segments are found by their data-key, so the group needs no ref per segment. */
const segmentsIn = (root: HTMLElement | null) =>
	Array.from(root?.querySelectorAll<HTMLElement>(':scope > [data-key]') ?? [])
const segmentIn = (root: HTMLElement | null, key: string | null) =>
	key === null ? undefined : segmentsIn(root).find(node => node.dataset.key === key)
/** The segment's box inside the group; the highlight scrolls with the segments, so no scroll offset applies. */
const boxOf = (node: HTMLElement) => [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight]

/**
 * Icon actions joined into one surface: a shared border and radius, hairline dividers, no gaps. One soft highlight glides
 * between segments under the pointer or keyboard focus, and the pressed segment answers in place.
 */
export function ButtonGroup({ items, label }: ButtonGroupProps) {
	const reduced = useReducedMotion() ?? false
	const root = useRef<HTMLDivElement>(null)

	// The highlight sits on the pointer's segment, else the pressed one (touch), else keyboard focus.
	const [hover, setHover] = useState<string | null>(null)
	const [pressed, setPressed] = useState<string | null>(null)
	const [focused, setFocused] = useState<string | null>(null)
	const active = hover ?? pressed ?? focused
	const activeIndex = active ? items.findIndex(item => item.id === active) : -1

	const x = useMotionValue(0),
		y = useMotionValue(0),
		width = useMotionValue(0),
		height = useMotionValue(0),
		opacity = useMotionValue(0)
	const shown = useRef<string | null>(null)

	useLayoutEffect(() => {
		const node = segmentIn(root.current, active)
		const fade = { duration: reduced ? motionTokens.duration.instant : motionTokens.duration.fast }
		if (!node) {
			if (shown.current) animate(opacity, 0, { ...fade, ease: [...motionTokens.ease.standard] })
			shown.current = null
			return
		}
		const target = boxOf(node)
		const values = [x, y, width, height]
		// Arriving from nowhere, it appears in place; only moves between segments travel.
		if (!shown.current || reduced) values.forEach((value, index) => value.jump(target[index]!))
		else values.forEach((value, index) => animate(value, target[index]!, motionTokens.spring.snappy))
		animate(opacity, 1, fade)
		shown.current = active
	}, [active, reduced, x, y, width, height, opacity])

	// Pressing tracks the segment under the finger, so touch gets the same highlight a pointer gets on hover.
	useEffect(() => {
		if (!pressed) return
		const release = () => setPressed(null)
		window.addEventListener('pointerup', release)
		window.addEventListener('pointercancel', release)
		return () => {
			window.removeEventListener('pointerup', release)
			window.removeEventListener('pointercancel', release)
		}
	}, [pressed])

	const hit = (event: PointerEvent) => {
		for (const node of segmentsIn(root.current))
			if (inside(node, event.clientX, event.clientY)) return node.dataset.key ?? null
		return null
	}

	// Keyboard focus shows the highlight; a mouse click focuses without it, so nothing stays lit after the pointer leaves.
	const onFocus = (event: FocusEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement
		const key = target.dataset.key
		if (key !== undefined) setFocused(target.matches(':focus-visible') ? key : null)
	}
	const onBlur = (event: FocusEvent<HTMLDivElement>) => {
		if (!root.current?.contains(event.relatedTarget as Node | null)) setFocused(null)
	}

	// Tab visits every segment in order; the arrow keys, Home and End also move between them.
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const list = segmentsIn(root.current)
		const index = list.findIndex(node => node === document.activeElement)
		if (index < 0) return
		const rtl = getComputedStyle(root.current!).direction === 'rtl'
		const last = list.length - 1
		const moves: Record<string, number> = {
			[rtl ? 'ArrowLeft' : 'ArrowRight']: index === last ? 0 : index + 1,
			[rtl ? 'ArrowRight' : 'ArrowLeft']: index === 0 ? last : index - 1,
			Home: 0,
			End: last,
		}
		const target = moves[event.key]
		if (target === undefined) return
		event.preventDefault()
		list[target]!.focus()
	}

	// A label that changes right after its segment is pressed, such as "Resume", is announced once.
	const [announcement, setAnnouncement] = useState('')
	const labels = useRef<Map<string, string> | null>(null)
	const activated = useRef({ key: '', at: 0 })
	const labelList = items.map(item => `${item.id}\u0000${item.label}`).join('\u0001')
	useEffect(() => {
		const previous = labels.current
		labels.current = new Map(items.map(item => [item.id, item.label]))
		if (!previous) return
		const recent = performance.now() - activated.current.at < 1000
		const changed = items.filter(
			item => recent && item.id === activated.current.key && previous.get(item.id) !== item.label,
		)
		if (changed.length) setAnnouncement(changed.map(item => item.label).join(', '))
		// labelList carries the only part of items this effect reads.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [labelList])

	return (
		<div
			ref={root}
			className='relative isolate inline-flex max-w-full [scrollbar-width:none] items-stretch overflow-x-auto overscroll-x-contain rounded-(--radius-control) border border-border bg-(--surface) align-middle text-foreground [&::-webkit-scrollbar]:hidden'
			role='group'
			aria-label={label}
			onPointerMove={event => event.pointerType !== 'touch' && setHover(hit(event))}
			onPointerLeave={() => setHover(null)}
			onPointerDown={event => event.button === 0 && setPressed(hit(event))}
			onFocus={onFocus}
			onBlur={onBlur}
			onKeyDown={onKeyDown}
		>
			{/* Motion sets its box to the active segment; the visible shape sits inset so the border stays crisp. */}
			<motion.span
				className="pointer-events-none absolute top-0 left-0 z-0 before:absolute before:inset-[3px] before:rounded-[calc(var(--radius-control)-4px)] before:bg-(--surface-muted) before:transition-colors before:duration-(--duration-fast) before:ease-(--ease-standard) before:content-[''] data-pressed:before:bg-[color-mix(in_oklab,var(--surface-muted),var(--border-strong)_30%)] data-pressed:before:duration-(--duration-instant) motion-reduce:before:transition-none"
				style={{ x, y, width, height, opacity }}
				data-pressed={pressed && pressed === active ? '' : undefined}
				aria-hidden='true'
			/>
			{items.map((item, index) => (
				<button
					key={item.id}
					type='button'
					data-key={item.id}
					// Hairline dividers fade where the highlight arrives, so it never sits beside a line.
					data-quiet={
						activeIndex >= 0 && (index === activeIndex || index === activeIndex + 1) ? '' : undefined
					}
					className="group/segment relative z-1 inline-flex size-[calc(var(--control-height-md)-2px)] flex-none cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-inherit select-none [-webkit-tap-highlight-color:transparent] not-first-of-type:before:pointer-events-none not-first-of-type:before:absolute not-first-of-type:before:inset-y-[9px] not-first-of-type:before:-left-[0.5px] not-first-of-type:before:w-px not-first-of-type:before:bg-border not-first-of-type:before:transition-opacity not-first-of-type:before:duration-(--duration-fast) not-first-of-type:before:content-[''] aria-pressed:bg-(--surface-muted) aria-pressed:text-foreground data-quiet:before:opacity-0 motion-reduce:before:transition-none"
					aria-label={item.label}
					aria-pressed={item.pressed}
					title={item.label}
					onClick={() => {
						activated.current = { key: item.id, at: performance.now() }
						item.onSelect?.()
					}}
				>
					{/* The press answers inside the segment: the icon dips and springs back, the group stays still. */}
					<span className='relative inline-grid place-items-center [transition:scale_var(--duration-spring)_var(--ease-spring)] group-active/segment:scale-90 group-active/segment:duration-(--duration-instant) group-active/segment:ease-(--ease-standard) motion-reduce:transition-none motion-reduce:group-active/segment:scale-100 [&_svg]:size-4 [&_svg]:stroke-[1.75] [&>*]:col-start-1 [&>*]:row-start-1'>
						<AnimatePresence initial={false}>
							<motion.span
								key={iconKey(item.icon)}
								className='inline-flex'
								initial={reduced ? { opacity: 0 } : iconIn}
								animate={rest}
								exit={reduced ? fadeOut : iconOut}
								transition={
									reduced
										? { duration: motionTokens.duration.instant }
										: {
												duration: motionTokens.duration.standard,
												ease: [...motionTokens.ease.enter],
											}
								}
								aria-hidden='true'
							>
								{item.icon}
							</motion.span>
						</AnimatePresence>
					</span>
				</button>
			))}
			<span className='sr-only' aria-live='polite'>
				{announcement}
			</span>
		</div>
	)
}
