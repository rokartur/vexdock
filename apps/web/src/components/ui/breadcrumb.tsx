import type { ReactNode } from 'react'
import { IconChevronRight } from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'

export type BreadcrumbItem = {
	label: string
	href?: string
	/** Drawn in place of the label, for a crumb that carries its own interaction (a picker). Never wrapped in a link. */
	node?: ReactNode
}

/** Each crumb reserves the width of its medium weight label, so becoming the current page never shifts the path. */
const crumb =
	'inline-flex flex-col rounded-[7px] px-0.5 py-1 after:pointer-events-none after:invisible after:h-0 after:overflow-hidden after:font-medium after:select-none after:content-[attr(data-label)]'

export function Breadcrumb({ items, className }: { items: BreadcrumbItem[]; className?: string }) {
	return (
		<nav aria-label='Breadcrumb' className={className}>
			{/* One line in the app's header: crumbs shrink and truncate instead of wrapping. */}
			<ol className='flex min-w-0 items-center gap-1.5 overflow-hidden'>
				{items.map((item, index) => {
					const current = index === items.length - 1
					return (
						<li
							key={`${item.label}-${index}`}
							// Phone widths only fit the page's own crumb next to the actions.
							className='inline-flex min-w-0 items-center gap-1.5 text-sm/[1.4] whitespace-nowrap text-muted max-sm:not-last:hidden'
						>
							{index > 0 && (
								<IconChevronRight
									aria-hidden
									stroke={1.75}
									className='size-4 flex-none text-border-strong max-sm:hidden'
								/>
							)}
							{item.node ? (
								<div className='flex min-w-0 items-center gap-1.5 text-foreground'>{item.node}</div>
							) : !current && item.href ? (
								<Link
									to={item.href}
									// exact: a crumb under the current URL is not the current page.
									activeOptions={{ exact: true }}
									data-label={item.label}
									className={`${crumb} text-secondary underline decoration-transparent underline-offset-4 transition-[color,text-decoration-color] duration-160 ease-standard hover:text-accent-strong hover:decoration-current/45`}
								>
									{item.label}
								</Link>
							) : (
								<span
									aria-current={current ? 'page' : undefined}
									data-label={item.label}
									className={`${crumb} aria-[current=page]:font-medium aria-[current=page]:text-accent-strong`}
								>
									{item.label}
								</span>
							)}
						</li>
					)
				})}
			</ol>
		</nav>
	)
}
