import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from 'cn'
import { LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type Segment = {
	value: string
	label: string
	/** Content after the label, such as a badge. */
	accessory?: ReactNode
}

export function SegmentedControl({
	options,
	value,
	onValueChange,
	label,
	onOptionIntent,
	className,
}: {
	options: Segment[]
	value: string
	onValueChange: (value: string) => void
	label?: string
	/** Called when the pointer or focus reaches an option before it is chosen, to start loading what it shows. */
	onOptionIntent?: (value: string) => void
	className?: string
}) {
	const id = useId()
	const reduced = useReducedMotion()
	const track = useRef<HTMLDivElement>(null)

	// Wider than its container, the track scrolls inside itself and fades only on the side with more to see.
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
		const observer = new ResizeObserver(edges)
		observer.observe(node)
		return () => {
			node.removeEventListener('scroll', edges)
			observer.disconnect()
		}
	}, [options.length])

	// The selected option scrolls fully into view, 20px clear of the fade; the first pass jumps instead of gliding.
	const first = useRef(true)
	useEffect(() => {
		const node = track.current
		const button = node?.querySelector<HTMLElement>('[aria-pressed="true"]')
		if (!node || !button || node.scrollWidth <= node.clientWidth) {
			first.current = false
			return
		}
		const room = 20
		const start = button.offsetLeft - room
		const end = button.offsetLeft + button.offsetWidth + room - node.clientWidth
		const left = node.scrollLeft > start ? start : node.scrollLeft < end ? end : node.scrollLeft
		if (left !== node.scrollLeft) {
			node.scrollTo({
				left: Math.max(0, left),
				behavior: first.current || reduced ? 'auto' : 'smooth',
			})
		}
		first.current = false
	}, [value, reduced])

	const selectedIndex = Math.max(
		0,
		options.findIndex(option => option.value === value),
	)

	function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
		const target = keyTarget(event.key, selectedIndex, options.length - 1)
		if (target < 0) return
		event.preventDefault()
		const next = options[target]!.value
		onValueChange(next)
		track.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next)}"]`)?.focus({ preventScroll: true })
	}

	return (
		<div
			role='group'
			aria-label={label}
			className={cn(
				'inline-flex max-w-full min-w-0 shrink rounded-control border border-border bg-surface-muted',
				className,
			)}
		>
			<LayoutGroup id={id}>
				<motion.div
					ref={track}
					layoutScroll
					className='isolate flex min-w-0 [scrollbar-width:none] gap-0.5 overflow-x-auto overscroll-x-contain rounded-[inherit] [mask-image:linear-gradient(to_right,transparent,black_var(--fade-start),black_calc(100%-var(--fade-end)),transparent)] p-[3px] [--fade-end:0px] [--fade-start:0px] data-fade-end:[--fade-end:20px] data-fade-start:[--fade-start:20px] [&::-webkit-scrollbar]:hidden'
				>
					{options.map((option, index) => (
						<button
							key={option.value}
							id={`${id}-${option.value}`}
							type='button'
							data-value={option.value}
							aria-pressed={value === option.value}
							tabIndex={index === selectedIndex ? 0 : -1}
							onClick={() => onValueChange(option.value)}
							onKeyDown={onKeyDown}
							onPointerEnter={onOptionIntent ? () => onOptionIntent(option.value) : undefined}
							onFocus={onOptionIntent ? () => onOptionIntent(option.value) : undefined}
							className='relative min-h-control-sm flex-none rounded-[calc(var(--radius-control)-4px)] px-3 text-sm font-medium whitespace-nowrap text-muted [-webkit-tap-highlight-color:transparent] hover:text-foreground active:text-foreground aria-pressed:text-foreground max-[380px]:px-2.5'
						>
							{value === option.value && (
								<motion.span
									aria-hidden
									layoutId='selection'
									layoutDependency={value}
									transition={reduced ? { duration: 0 } : motionTokens.spring.morph}
									className='absolute inset-0 -z-1 rounded-[inherit] border border-border bg-surface shadow-resting'
								/>
							)}
							<span className='relative z-1 inline-flex items-center gap-1.5'>
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

// Arrows wrap at the ends, Home and End jump to them; -1 leaves the key to the page.
function keyTarget(key: string, selectedIndex: number, last: number) {
	if (key === 'ArrowRight' || key === 'ArrowDown') return selectedIndex === last ? 0 : selectedIndex + 1
	if (key === 'ArrowLeft' || key === 'ArrowUp') return selectedIndex === 0 ? last : selectedIndex - 1
	if (key === 'Home') return 0
	if (key === 'End') return last
	return -1
}
