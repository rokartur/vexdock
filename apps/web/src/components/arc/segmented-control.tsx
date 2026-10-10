'use client'

import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'

export interface Segment {
	value: string
	label: string
	/** Optional leading glyph, such as a brand icon. */ icon?: ReactNode
	/** Optional content after the label, such as a badge. */ accessory?: ReactNode
}
export interface SegmentedControlProps {
	options: Segment[]
	value: string
	onValueChange: (value: string) => void
	label?: string
	className?: string
}

export default function SegmentedControl({ options, value, onValueChange, label, className }: SegmentedControlProps) {
	const id = useId()
	const reduced = useReducedMotion()
	const track = useRef<HTMLDivElement>(null)

	// When the options are wider than the container, the track scrolls inside itself. Edges fade only on the side with more to see.
	useLayoutEffect(() => {
		const node = track.current
		if (!node) return
		const edges = () => {
			const rest = node.scrollWidth - node.clientWidth - node.scrollLeft
			node.toggleAttribute('data-fade-start', node.scrollLeft > 1)
			node.toggleAttribute('data-fade-end', rest > 1)
		}
		edges()
		node.addEventListener('scroll', edges, { passive: true })
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(edges)
		observer?.observe(node)
		return () => {
			node.removeEventListener('scroll', edges)
			observer?.disconnect()
		}
	}, [options.length])

	// The selected option is always scrolled fully into view, with a little room so it clears the fade.
	const first = useRef(true)
	useEffect(() => {
		const node = track.current
		const button = node?.querySelector<HTMLElement>('[aria-pressed="true"]')
		if (!node || !button || node.scrollWidth <= node.clientWidth) {
			first.current = false
			return
		}
		const room = 20,
			start = button.offsetLeft - room,
			end = button.offsetLeft + button.offsetWidth + room - node.clientWidth
		const left = node.scrollLeft > start ? start : node.scrollLeft < end ? end : node.scrollLeft
		if (left !== node.scrollLeft)
			node.scrollTo({ left: Math.max(0, left), behavior: first.current || reduced ? 'auto' : 'smooth' })
		first.current = false
	}, [value, reduced])

	// Arrow keys, Home and End move the selection like a tab list; only the selected option is a tab stop.
	const selectedIndex = Math.max(
		0,
		options.findIndex(option => option.value === value),
	)
	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		const last = options.length - 1
		const target =
			event.key === 'ArrowRight' || event.key === 'ArrowDown'
				? selectedIndex === last
					? 0
					: selectedIndex + 1
				: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
					? selectedIndex === 0
						? last
						: selectedIndex - 1
					: event.key === 'Home'
						? 0
						: event.key === 'End'
							? last
							: -1
		if (target < 0 || !options[target]) return
		event.preventDefault()
		onValueChange(options[target].value)
		track.current
			?.querySelector<HTMLElement>(`[data-value="${CSS.escape(options[target].value)}"]`)
			?.focus({ preventScroll: true })
	}

	return (
		<div
			className={cn(
				'inline-flex max-w-full min-w-0 shrink rounded-(--radius-control) border border-border bg-(--surface-muted)',
				className,
			)}
			role='group'
			aria-label={label}
		>
			<LayoutGroup id={id}>
				{/* The track owns the stacking context so the gliding highlight passes under every label, not over earlier ones. */}
				<motion.div
					ref={track}
					layoutScroll
					className='isolate flex min-w-0 [scrollbar-width:none] gap-0.5 overflow-x-auto overscroll-x-contain rounded-[inherit] mask-[linear-gradient(to_right,transparent,#000_var(--fade-start),#000_calc(100%-var(--fade-end)),transparent)] p-[3px] [--fade-end:0px] [--fade-start:0px] data-fade-end:[--fade-end:20px] data-fade-start:[--fade-start:20px] [&::-webkit-scrollbar]:hidden'
				>
					{options.map((option, index) => (
						<button
							key={option.value}
							id={`${id}-${option.value}`}
							// Items never scale or change weight; only the highlight travels and the label color follows it.
							className='relative min-h-6 flex-none cursor-pointer rounded-[calc(var(--radius-control)-4px)] border-0 bg-transparent px-3 text-sm font-medium whitespace-nowrap text-(--text-muted) transition-colors duration-(--duration-fast) ease-(--ease-standard) [-webkit-tap-highlight-color:transparent] hover:text-foreground active:text-foreground aria-pressed:text-foreground motion-reduce:transition-none max-[380px]:px-2.5'
							type='button'
							data-value={option.value}
							aria-pressed={value === option.value}
							tabIndex={index === selectedIndex ? 0 : -1}
							onClick={() => onValueChange(option.value)}
							onKeyDown={onKeyDown}
						>
							{value === option.value && (
								<motion.span
									className='absolute inset-0 -z-1 rounded-[inherit] border border-border bg-(--surface) shadow-(--shadow-resting)'
									layoutId='selection'
									layoutDependency={value}
									transition={reduced ? { duration: 0 } : motionTokens.spring.morph}
									aria-hidden='true'
								/>
							)}
							<span className='relative z-1 inline-flex items-center gap-1.5 [&_svg]:size-4 [&_svg]:flex-none'>
								{option.icon}
								{option.label}
								{option.accessory}
							</span>
						</button>
					))}
				</motion.div>
			</LayoutGroup>
		</div>
	)
}
