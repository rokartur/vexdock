'use client'

import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/utils/cn'
import { ArcLink } from './arc-provider'
import { motionTokens } from './motion-tokens'

const TabsContext = createContext('')

type WithClassName<T> = Omit<T, 'className'> & { className?: string }

export function Tabs({
	value,
	className,
	...props
}: WithClassName<ComponentPropsWithoutRef<typeof TabsPrimitive.Root>>) {
	const layoutId = useId()
	return (
		<TabsContext.Provider value={value ?? ''}>
			<LayoutGroup id={layoutId}>
				<TabsPrimitive.Root {...props} value={value} className={cn('relative', className)} />
			</LayoutGroup>
		</TabsContext.Provider>
	)
}

const scrollButton =
	'absolute inset-y-0 z-2 grid w-[33px] place-items-center border-0 bg-(--surface-muted) text-foreground [--focus-outline-offset:-3px] disabled:pointer-events-none disabled:opacity-0'

export function TabsList({ className, ...props }: WithClassName<ComponentPropsWithoutRef<typeof TabsPrimitive.List>>) {
	const active = useContext(TabsContext)
	const reduced = useReducedMotion()
	const shell = useRef<HTMLDivElement>(null)
	const viewport = useRef<HTMLDivElement>(null)
	const list = useRef<HTMLDivElement>(null)
	const [edges, setEdges] = useState({ overflow: false, left: false, right: false })
	const update = useCallback(() => {
		const frame = shell.current
		const scroll = viewport.current
		if (!frame || !scroll) return
		const max = Math.max(0, scroll.scrollWidth - scroll.clientWidth)
		const next = {
			overflow: scroll.scrollWidth > frame.clientWidth + 1,
			left: scroll.scrollLeft > 1,
			right: scroll.scrollLeft < max - 1,
		}
		setEdges(previous =>
			previous.overflow === next.overflow && previous.left === next.left && previous.right === next.right
				? previous
				: next,
		)
	}, [])
	const reveal = useCallback(
		(tab: HTMLElement | null) => {
			const scroll = viewport.current
			if (!scroll || !tab) return
			const frame = scroll.getBoundingClientRect()
			const item = tab.getBoundingClientRect()
			const max = Math.max(0, scroll.scrollWidth - scroll.clientWidth)
			const left = frame.left + (scroll.scrollLeft > 1 ? 34 : 0)
			const right = frame.right - (scroll.scrollLeft < max - 1 ? 34 : 0)
			const delta = item.left < left ? item.left - left : item.right > right ? item.right - right : 0
			if (delta) scroll.scrollBy({ left: delta, behavior: reduced ? 'instant' : 'smooth' })
		},
		[reduced],
	)
	useLayoutEffect(() => {
		const frame = shell.current
		const scroll = viewport.current
		const content = list.current
		if (!frame || !scroll || !content) return
		const observer = new ResizeObserver(update)
		observer.observe(frame)
		observer.observe(scroll)
		observer.observe(content)
		scroll.addEventListener('scroll', update, { passive: true })
		update()
		return () => {
			observer.disconnect()
			scroll.removeEventListener('scroll', update)
		}
	}, [update])
	useLayoutEffect(() => {
		reveal(list.current?.querySelector<HTMLElement>('[role="tab"][data-active]') ?? null)
	}, [active, reveal])
	const scrollTabs = (direction: number) =>
		viewport.current?.scrollBy({
			left: direction * (viewport.current?.clientWidth ?? 0) * 0.75,
			behavior: reduced ? 'instant' : 'smooth',
		})
	return (
		<div
			ref={shell}
			className='relative isolate inline-flex max-w-full min-w-0 items-center rounded-(--radius-control) border border-border bg-(--surface-muted)'
		>
			{edges.overflow && (
				<button
					type='button'
					className={cn(scrollButton, 'left-0 rounded-l-(--radius-control)')}
					aria-label='Scroll tabs left'
					disabled={!edges.left}
					onClick={() => scrollTabs(-1)}
				>
					<IconChevronLeft size={17} stroke={1.75} aria-hidden='true' />
				</button>
			)}
			<motion.div
				ref={viewport}
				layoutScroll
				className={cn(
					'min-w-0 [scrollbar-width:none] overflow-x-auto rounded-[inherit] [&::-webkit-scrollbar]:hidden',
					edges.left && edges.right
						? 'mask-[linear-gradient(to_right,transparent,#000_35px,#000_calc(100%-35px),transparent)]'
						: edges.left
							? 'mask-[linear-gradient(to_right,transparent,#000_35px,#000)]'
							: edges.right && 'mask-[linear-gradient(to_right,#000,#000_calc(100%-35px),transparent)]',
				)}
				onFocusCapture={event => {
					if (event.target instanceof HTMLElement && event.target.getAttribute('role') === 'tab')
						reveal(event.target)
				}}
			>
				{/* The list owns the stacking context so the gliding highlight passes under every label, not over earlier ones. */}
				<TabsPrimitive.List
					{...props}
					ref={list}
					className={cn('isolate inline-flex w-max items-center gap-0.5 p-[3px]', className)}
				/>
			</motion.div>
			{edges.overflow && (
				<button
					type='button'
					className={cn(scrollButton, 'right-0 rounded-r-(--radius-control)')}
					aria-label='Scroll tabs right'
					disabled={!edges.right}
					onClick={() => scrollTabs(1)}
				>
					<IconChevronRight size={17} stroke={1.75} aria-hidden='true' />
				</button>
			)}
		</div>
	)
}

export function TabsTrigger({
	className,
	children,
	value,
	href,
	...props
}: WithClassName<ComponentPropsWithoutRef<typeof TabsPrimitive.Tab>> & {
	/** Makes the tab a link: the URL owns which tab is active, through the `value` passed to Tabs. */
	href?: string
}) {
	const active = useContext(TabsContext)
	const reduced = useReducedMotion()
	const classes = cn(
		'relative inline-grid min-h-6 flex-none cursor-pointer place-items-center rounded-[calc(var(--radius-control)-3px)] border-0 bg-transparent px-3 text-sm font-medium whitespace-nowrap text-(--text-muted) no-underline transition-colors duration-(--duration-fast) ease-(--ease-standard) [-webkit-tap-highlight-color:transparent] hover:text-foreground active:text-foreground data-active:text-(--accent-strong) data-disabled:cursor-not-allowed data-disabled:opacity-50 motion-reduce:transition-none',
		className,
	)
	// The LayoutGroup in Tabs scopes the highlight to this instance, so it glides between triggers but never flies in from another tab set.
	const inner = (
		<>
			{active === value && (
				<motion.span
					className='absolute inset-0 -z-1 rounded-[inherit] border border-border bg-(--surface) shadow-(--shadow-resting) will-change-transform'
					layoutId='selection'
					layoutDependency={active}
					transition={reduced ? { duration: 0 } : motionTokens.spring.morph}
					aria-hidden='true'
				/>
			)}
			<span className='relative z-1'>{children}</span>
		</>
	)
	if (href !== undefined)
		return (
			<TabsPrimitive.Tab
				{...props}
				value={value}
				className={classes}
				nativeButton={false}
				render={<ArcLink href={href} />}
			>
				{inner}
			</TabsPrimitive.Tab>
		)
	return (
		<TabsPrimitive.Tab {...props} value={value} className={classes}>
			{inner}
		</TabsPrimitive.Tab>
	)
}
