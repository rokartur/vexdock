'use client'
import type { ReactNode } from 'react'
import { IconChevronRight } from '@tabler/icons-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArcLink } from './arc-provider'
import { motionTokens } from './motion-tokens'
export interface BreadcrumbItem {
	label: string
	href?: string
	/** Drawn in place of the label, for a crumb that carries its own interaction (a picker). Never wrapped in a link. */
	node?: ReactNode
}
export interface BreadcrumbProps {
	items: BreadcrumbItem[]
	ariaLabel?: string
	className?: string
}

/** Each crumb reserves the width of its medium weight label, so becoming the current page never shifts the path. */
const crumb =
	'inline-flex flex-col rounded-[7px] px-0.5 py-1 after:pointer-events-none after:invisible after:h-0 after:overflow-hidden after:font-medium after:select-none after:content-[attr(data-label)]'

/** Crumbs present on first render stay still; crumbs added later slide in from the path before them. */
export function Breadcrumb({ items, ariaLabel = 'Breadcrumb', className }: BreadcrumbProps) {
	const reduced = useReducedMotion() ?? false
	const still = { duration: 0 }
	const path = items.map(item => item.label).join('/')
	return (
		<nav aria-label={ariaLabel} className={className}>
			{/* One line in the app's header: crumbs shrink and truncate instead of wrapping. */}
			<ol className='relative m-0 flex min-w-0 list-none flex-nowrap items-center gap-x-1.5 gap-y-0.5 overflow-hidden p-0'>
				<AnimatePresence mode='popLayout' initial={false}>
					{items.map((item, index) => {
						const current = index === items.length - 1
						return (
							<motion.li
								key={`${item.label}-${index}`}
								// Phone widths only fit the page's own crumb next to the actions.
								className='inline-flex min-w-0 items-center gap-1.5 text-sm/(--leading-body) whitespace-nowrap text-(--text-muted) max-sm:not-last:hidden'
								layout={reduced ? false : 'position'}
								layoutDependency={path}
								initial={
									reduced
										? false
										: { opacity: 0, x: -8, filter: `blur(${motionTokens.blur.subtle}px)` }
								}
								animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
								exit={
									reduced
										? { opacity: 0, transition: still }
										: {
												opacity: 0,
												x: -4,
												filter: `blur(${motionTokens.blur.subtle}px)`,
												transition: {
													duration: motionTokens.duration.instant,
													ease: [...motionTokens.ease.standard],
												},
											}
								}
								transition={
									reduced
										? still
										: {
												duration: motionTokens.duration.standard,
												ease: [...motionTokens.ease.enter],
												layout: motionTokens.spring.smooth,
											}
								}
							>
								{index > 0 && (
									<IconChevronRight
										className='size-4 flex-none text-(--border-strong) max-sm:hidden'
										stroke={1.75}
										aria-hidden='true'
									/>
								)}
								{item.node ? (
									<div className='flex min-w-0 items-center gap-1.5 text-foreground'>{item.node}</div>
								) : !current && item.href ? (
									<ArcLink
										href={item.href}
										data-label={item.label}
										className={`${crumb} text-(--text-secondary) underline decoration-transparent decoration-1 underline-offset-4 transition-[color,text-decoration-color] duration-(--duration-fast) ease-(--ease-standard) hover:text-(--accent-strong) hover:decoration-[color-mix(in_oklab,currentColor_45%,transparent)] motion-reduce:transition-none`}
									>
										{item.label}
									</ArcLink>
								) : (
									<span
										aria-current={current ? 'page' : undefined}
										data-label={item.label}
										className={`${crumb} aria-[current=page]:font-medium aria-[current=page]:text-(--accent-strong)`}
									>
										{item.label}
									</span>
								)}
							</motion.li>
						)
					})}
				</AnimatePresence>
			</ol>
		</nav>
	)
}
