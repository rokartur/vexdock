import { useLayoutEffect, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'

type WithClassName<T> = Omit<T, 'className'> & { className?: string }

export function Tabs({ className, ...props }: WithClassName<ComponentProps<typeof TabsPrimitive.Root>>) {
	return <TabsPrimitive.Root {...props} className={cn('relative min-w-0', className)} />
}

/** The track scrolls inside itself when the tabs are wider than it; the side with more to see fades and gets an arrow. */
export function TabsList({ className, children, ...props }: WithClassName<ComponentProps<typeof TabsPrimitive.List>>) {
	const viewport = useRef<HTMLDivElement>(null)
	const [edges, setEdges] = useState({ left: false, right: false })

	useLayoutEffect(() => {
		const scroll = viewport.current
		if (!scroll) return
		const update = () => {
			const max = scroll.scrollWidth - scroll.clientWidth
			const next = { left: scroll.scrollLeft > 1, right: scroll.scrollLeft < max - 1 }
			setEdges(previous => (previous.left === next.left && previous.right === next.right ? previous : next))
		}
		const observer = new ResizeObserver(update)
		observer.observe(scroll)
		if (scroll.firstElementChild) observer.observe(scroll.firstElementChild)
		scroll.addEventListener('scroll', update, { passive: true })
		update()
		return () => {
			observer.disconnect()
			scroll.removeEventListener('scroll', update)
		}
	}, [])

	// A new active tab (a click, a new URL) is scrolled clear of the faded edge. Only a new one: re-revealing on every
	// render would undo the arrows, whose scroll re-renders this through setEdges.
	const revealed = useRef<HTMLElement | null>(null)
	useLayoutEffect(() => {
		const active = viewport.current?.querySelector<HTMLElement>('[role="tab"][data-active]') ?? null
		if (active === revealed.current) return
		revealed.current = active
		reveal(viewport.current, active)
	})

	const scrollBy = (direction: number) => {
		const scroll = viewport.current
		if (scroll) scroll.scrollBy({ left: direction * scroll.clientWidth * 0.75, behavior: scrollBehavior() })
	}

	return (
		<div className='relative isolate inline-flex max-w-full min-w-0 rounded-control bg-surface-muted/50'>
			{edges.left ? (
				<ScrollButton
					label='Scroll tabs left'
					className='left-0 rounded-l-[inherit]'
					onClick={() => scrollBy(-1)}
				>
					<IconChevronLeft aria-hidden />
				</ScrollButton>
			) : null}
			<div
				ref={viewport}
				onFocusCapture={event => {
					if (event.target instanceof HTMLElement && event.target.role === 'tab')
						reveal(viewport.current, event.target)
				}}
				className={cn(
					// Tabs are fully hidden under the 32px scroll button, which has no fill: the track behind it is translucent.
					'min-w-0 [scrollbar-width:none] overflow-x-auto overscroll-x-contain rounded-[inherit] mask-[linear-gradient(to_right,transparent_var(--fade-left),black_calc(var(--fade-left)*1.75),black_calc(100%-var(--fade-right)*1.75),transparent_calc(100%-var(--fade-right)))] [--fade-left:0px] [--fade-right:0px] [&::-webkit-scrollbar]:hidden',
					edges.left && '[--fade-left:32px]',
					edges.right && '[--fade-right:32px]',
				)}
			>
				<TabsPrimitive.List
					{...props}
					className={cn('relative isolate flex w-max items-center gap-0.5 p-[3px]', className)}
				>
					<TabsPrimitive.Indicator className='absolute top-[3px] bottom-[3px] left-0 -z-10 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-[calc(var(--radius-control)-3px)] bg-surface-muted transition-[translate,width] duration-580 ease-spring' />
					{children}
				</TabsPrimitive.List>
			</div>
			{edges.right ? (
				<ScrollButton
					label='Scroll tabs right'
					className='right-0 rounded-r-[inherit]'
					onClick={() => scrollBy(1)}
				>
					<IconChevronRight aria-hidden />
				</ScrollButton>
			) : null}
		</div>
	)
}

export function TabsTrigger({
	className,
	href,
	...props
}: WithClassName<ComponentProps<typeof TabsPrimitive.Tab>> & {
	/** Makes the tab a router link: the URL owns which tab is active, through the `value` passed to Tabs. */
	href?: string
}) {
	// Text tabs are a high-frequency switch: the indicator glides, the label color changes instantly.
	const classes = cn(
		'inline-flex min-h-7.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-[calc(var(--radius-control)-3px)] px-3.5 text-sm font-medium whitespace-nowrap text-muted no-underline select-none hover:text-foreground data-active:text-accent-strong data-disabled:cursor-not-allowed data-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
		className,
	)
	if (href === undefined) return <TabsPrimitive.Tab {...props} className={classes} />
	return (
		<TabsPrimitive.Tab
			{...props}
			className={classes}
			nativeButton={false}
			render={<Link to={href} activeOptions={{ exact: true }} />}
		/>
	)
}

function ScrollButton({
	label,
	className,
	onClick,
	children,
}: {
	label: string
	className: string
	onClick: () => void
	children: ReactNode
}) {
	return (
		<button
			type='button'
			aria-label={label}
			onClick={onClick}
			className={cn(
				'absolute inset-y-0 z-10 grid w-8 cursor-pointer place-items-center text-secondary [--focus-outline-offset:-3px] hover:text-foreground [&_svg]:size-4',
				className,
			)}
		>
			{children}
		</button>
	)
}

function reveal(scroll: HTMLElement | null, tab: HTMLElement | null) {
	if (!scroll || !tab) return
	const frame = scroll.getBoundingClientRect()
	const item = tab.getBoundingClientRect()
	const max = scroll.scrollWidth - scroll.clientWidth
	// The faded edge covers 32px; an arrow sits over it while there is more on that side.
	const left = frame.left + (scroll.scrollLeft > 1 ? 32 : 0)
	const right = frame.right - (scroll.scrollLeft < max - 1 ? 32 : 0)
	if (item.left < left) scroll.scrollBy({ left: item.left - left, behavior: scrollBehavior() })
	else if (item.right > right) scroll.scrollBy({ left: item.right - right, behavior: scrollBehavior() })
}

function scrollBehavior(): ScrollBehavior {
	return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
}
