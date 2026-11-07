import type { MouseEvent, ReactNode } from 'react'
import { IconChevronRight } from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type BreadcrumbItem = {
	label: string
	href?: string
	// Without an href the crumb renders as a button, for paths that live in local state.
	onClick?: (event: MouseEvent<HTMLElement>) => void
	// vexdock: drawn in place of the label when the crumb carries its own interaction (a picker).
	node?: ReactNode
}

type BreadcrumbProps = {
	items: BreadcrumbItem[]
	ariaLabel?: string
	// vexdock: the app header lists only a page's parents (its h1 is the page), so its last crumb stays a link.
	lastIsCurrent?: boolean
}

const { blur, duration, ease, spring } = motionTokens
const still = { duration: 0 }

// Each crumb reserves the width of its medium weight label, so becoming the current page never shifts the path.
// vexdock: `min-w-0 max-w-full` and the label's own `truncate` end a long name in an ellipsis instead of mid-letter.
const crumb =
	'inline-flex min-w-0 max-w-full flex-col rounded-[7px] px-0.5 py-1 after:pointer-events-none after:invisible after:h-0 after:overflow-hidden after:font-medium after:select-none after:content-[attr(data-label)]'
// vexdock: `press` (in place of Arc's transition) scales a crumb under the pointer and the press draws its underline whole.
const link =
	'press text-secondary underline decoration-transparent decoration-1 underline-offset-4 hover:text-accent-strong hover:decoration-current/45 active:decoration-current'

// Crumbs present on first render stay still; crumbs added later slide in from the path before them.
export function Breadcrumb({ items, ariaLabel = 'Breadcrumb', lastIsCurrent = true }: BreadcrumbProps) {
	const reduced = useReducedMotion() ?? false
	const path = items.map(item => item.label).join('/')

	return (
		<nav aria-label={ariaLabel}>
			{/* The gap between crumbs matches the gap inside one, so every chevron sits centered between its two labels. */}
			{/* vexdock: one line in the app header, so crumbs clip instead of wrapping; the 4px padding keeps a crumb's
			    2px focus ring at 2px offset inside the clip. */}
			<ol className='relative -m-1 flex min-w-0 items-center gap-x-1.5 gap-y-0.5 overflow-hidden p-1'>
				<AnimatePresence mode='popLayout' initial={false}>
					{items.map((item, index) => (
						<motion.li
							key={`${item.label}-${index}`}
							// vexdock: phone widths only fit the nearest parent crumb above the h1, next to the header actions.
							className='inline-flex min-w-0 items-center gap-1.5 text-sm whitespace-nowrap text-muted max-sm:not-last:hidden'
							layout={reduced ? false : 'position'}
							layoutDependency={path}
							initial={reduced ? false : { opacity: 0, x: -8, filter: `blur(${blur.subtle}px)` }}
							animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
							exit={
								reduced
									? { opacity: 0, transition: still }
									: {
											opacity: 0,
											x: -4,
											filter: `blur(${blur.subtle}px)`,
											transition: { duration: duration.instant, ease: [...ease.standard] },
										}
							}
							transition={
								reduced
									? still
									: { duration: duration.standard, ease: [...ease.enter], layout: spring.smooth }
							}
						>
							{index > 0 && (
								<IconChevronRight
									size={16}
									stroke={1.75}
									aria-hidden='true'
									// vexdock: phone widths show one crumb, so no chevron leads it.
									className='flex-none text-border-strong max-sm:hidden'
								/>
							)}
							<Crumb item={item} current={lastIsCurrent && index === items.length - 1} />
						</motion.li>
					))}
				</AnimatePresence>
			</ol>
		</nav>
	)
}

// The current crumb is never a link.
function Crumb({ item, current }: { item: BreadcrumbItem; current: boolean }) {
	if (item.node) {
		return <div className='flex min-w-0 items-center gap-1.5 text-foreground'>{item.node}</div>
	}
	// vexdock: a router Link in place of Arc's <a>, so a crumb navigates inside the app instead of reloading it.
	if (!current && item.href) {
		return (
			<Link
				to={item.href}
				activeOptions={{ exact: true }}
				data-label={item.label}
				onClick={item.onClick}
				className={cn(crumb, link)}
			>
				<span className='truncate'>{item.label}</span>
			</Link>
		)
	}
	if (!current && item.onClick) {
		return (
			<button
				type='button'
				data-label={item.label}
				onClick={item.onClick}
				className={cn(crumb, link, 'text-start')}
			>
				<span className='truncate'>{item.label}</span>
			</button>
		)
	}
	return (
		<span
			aria-current={current ? 'page' : undefined}
			data-label={item.label}
			className={cn(crumb, current && 'font-medium text-accent-strong transition-[color]')}
		>
			<span className='truncate'>{item.label}</span>
		</span>
	)
}
