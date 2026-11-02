import { useLayoutEffect, useRef, useState } from 'react'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { cn } from 'cn'
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, type Variants } from 'motion/react'
import { motionTokens } from '../../lib/motion'

const { duration, ease, spring } = motionTokens

export interface PaginationProps {
	page: number
	pageCount: number
	onPageChange: (page: number) => void
	label?: string
}

// One button plus the gap (28px + 4px) as a percentage of the button width: shifted numbers travel like a belt.
const slot = 800 / 7

const slide: Variants = {
	enter: (shift: number) => ({ opacity: 0, x: `${slot * shift}%` }),
	center: { opacity: 1, x: '0%' },
	exit: (shift: number) => ({
		opacity: 0,
		x: `${-slot * shift}%`,
		transition: {
			x: spring.smooth,
			opacity: { duration: duration.instant, ease: [...ease.standard] },
		},
	}),
}

const navClass = 'group/nav relative flex flex-wrap items-center gap-1'
const buttonClass =
	'relative grid size-control-sm place-items-center rounded-control border border-transparent bg-transparent text-xs text-secondary tabular-nums motion-reduce:transition-none hover:bg-surface-muted hover:text-foreground disabled:opacity-40 aria-[current=page]:text-foreground'
// Only the arrows press in: page numbers move with Motion, so CSS stays off their transforms.
const stepClass =
	'[transition:background-color_110ms_var(--ease-standard),color_110ms_var(--ease-standard),opacity_110ms_var(--ease-standard),scale_400ms_var(--ease-spring)] motion-safe:active:scale-96 active:[transition-duration:110ms,110ms,110ms,70ms] active:[transition-timing-function:var(--ease-standard),var(--ease-standard),var(--ease-standard),cubic-bezier(0,0,0.58,1)]'

export function Pagination({ page, pageCount, onPageChange, label = 'Pagination' }: PaginationProps) {
	const reduced = useReducedMotion() ?? false
	const navRef = useRef<HTMLElement>(null)
	const markX = useMotionValue(0)
	const markY = useMotionValue(0)
	const safePageCount = Math.max(0, Math.floor(pageCount))
	const currentPage = safePageCount > 0 ? Math.min(Math.max(1, Math.floor(page)), safePageCount) : 0
	const start = safePageCount > 0 ? Math.max(1, Math.min(safePageCount - 4, currentPage - 2)) : 1
	const [previousStart, setPreviousStart] = useState(start)
	const [shift, setShift] = useState(0)
	if (previousStart !== start) {
		setShift(start - previousStart)
		setPreviousStart(start)
	}
	const visible = Array.from({ length: Math.min(safePageCount, 5) }, (_, index) => start + index)

	// Until the mark has measured once (and during server render) the current button draws its own border.
	useLayoutEffect(() => {
		const nav = navRef.current
		const current = nav?.querySelector<HTMLElement>("[aria-current='page']")
		if (!nav || !current) return
		const place = (instant: boolean) => {
			const x = current.offsetLeft
			const y = current.offsetTop
			if (instant || reduced) {
				markX.jump(x)
				markY.jump(y)
				return
			}
			animate(markX, x, spring.morph)
			animate(markY, y, spring.morph)
		}
		place(!('markReady' in nav.dataset))
		nav.dataset.markReady = ''
		let size = `${nav.offsetWidth}x${nav.offsetHeight}`
		const observer = new ResizeObserver(() => {
			const next = `${nav.offsetWidth}x${nav.offsetHeight}`
			if (next === size) return
			size = next
			place(true)
		})
		observer.observe(nav)
		return () => observer.disconnect()
	}, [currentPage, start, safePageCount, reduced, markX, markY])

	if (!safePageCount) return <nav aria-label={label} className={navClass} />

	return (
		<nav ref={navRef} aria-label={label} className={navClass}>
			<button
				type='button'
				onClick={() => onPageChange(currentPage - 1)}
				disabled={currentPage <= 1}
				aria-label='Previous page'
				className={cn(buttonClass, stepClass)}
			>
				<IconChevronLeft size={16} aria-hidden />
			</button>
			<motion.span
				aria-hidden
				style={{ x: markX, y: markY }}
				className='pointer-events-none absolute top-0 left-0 size-control-sm rounded-control border border-border bg-surface opacity-0 shadow-resting transition-none group-data-mark-ready/nav:opacity-100'
			/>
			<AnimatePresence mode='popLayout' initial={false} custom={shift}>
				{visible.map(number => (
					<motion.button
						type='button'
						key={number}
						onClick={() => onPageChange(number)}
						aria-label={`Page ${number}`}
						aria-current={currentPage === number ? 'page' : undefined}
						layout={reduced ? false : 'position'}
						layoutDependency={start}
						custom={shift}
						variants={slide}
						initial={reduced ? false : 'enter'}
						animate='center'
						exit={reduced ? undefined : 'exit'}
						transition={
							reduced
								? { duration: 0 }
								: {
										x: spring.smooth,
										layout: spring.smooth,
										opacity: { duration: duration.standard, ease: [...ease.enter] },
									}
						}
						className={cn(
							buttonClass,
							'transition-[background-color,color]',
							'group-not-data-mark-ready/nav:aria-[current=page]:border-border group-not-data-mark-ready/nav:aria-[current=page]:bg-surface group-not-data-mark-ready/nav:aria-[current=page]:shadow-resting',
							'group-data-mark-ready/nav:aria-[current=page]:hover:bg-transparent',
						)}
					>
						{number}
					</motion.button>
				))}
			</AnimatePresence>
			<button
				type='button'
				onClick={() => onPageChange(currentPage + 1)}
				disabled={currentPage >= safePageCount}
				aria-label='Next page'
				className={cn(buttonClass, stepClass)}
			>
				<IconChevronRight size={16} aria-hidden />
			</button>
		</nav>
	)
}
