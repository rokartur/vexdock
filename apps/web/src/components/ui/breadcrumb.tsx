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

type BreadcrumbProps = { items: BreadcrumbItem[]; ariaLabel?: string; className?: string }

const { blur, duration, ease, spring } = motionTokens
const still = { duration: 0 }

// Each crumb reserves the width of its medium weight label, so becoming the current page never shifts the path.
const crumb =
	'inline-flex flex-col rounded-[7px] px-0.5 py-1 after:pointer-events-none after:invisible after:h-0 after:overflow-hidden after:font-medium after:select-none after:content-[attr(data-label)]'
const link =
	'text-secondary underline decoration-transparent decoration-1 underline-offset-4 transition-[color,text-decoration-color] hover:text-accent-strong hover:decoration-current/45'

// Crumbs present on first render stay still; crumbs added later slide in from the path before them.
export function Breadcrumb({ items, ariaLabel = 'Breadcrumb', className }: BreadcrumbProps) {
	const reduced = useReducedMotion() ?? false
	const path = items.map(item => item.label).join('/')

	return (
		<nav aria-label={ariaLabel} className={className}>
			{/* The gap between crumbs matches the gap inside one, so every chevron sits centered between its two labels. */}
			{/* vexdock: one line in the app header, so crumbs truncate instead of wrapping. */}
			<ol className='relative flex min-w-0 items-center gap-x-1.5 gap-y-0.5 overflow-hidden'>
				<AnimatePresence mode='popLayout' initial={false}>
					{items.map((item, index) => (
						<motion.li
							key={`${item.label}-${index}`}
							// vexdock: phone widths only fit the page's own crumb next to the header actions.
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
							<Crumb item={item} current={index === items.length - 1} />
						</motion.li>
					))}
				</AnimatePresence>
			</ol>
		</nav>
	)
}

// The last item is the current page and never a link.
function Crumb({ item, current }: { item: BreadcrumbItem; current: boolean }) {
	if (item.node) {
		return <div className='flex min-w-0 items-center gap-1.5 text-foreground'>{item.node}</div>
	}
	if (!current && item.href) {
		return (
			<Link
				to={item.href}
				activeOptions={{ exact: true }}
				data-label={item.label}
				onClick={item.onClick}
				className={cn(crumb, link)}
			>
				{item.label}
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
				{item.label}
			</button>
		)
	}
	return (
		<span
			aria-current={current ? 'page' : undefined}
			data-label={item.label}
			className={cn(crumb, current && 'font-medium text-accent-strong transition-[color]')}
		>
			{item.label}
		</span>
	)
}
