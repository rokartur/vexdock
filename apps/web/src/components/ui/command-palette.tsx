import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { IconCommand, IconSearch, IconX } from '@tabler/icons-react'
import {
	AnimatePresence,
	animate,
	motion,
	type Transition,
	useMotionValue,
	useReducedMotion,
	type ValueAnimationTransition,
	type Variants,
} from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type CommandItem = {
	id: string
	label: string
	description?: string
	group?: string
	keywords?: string[]
	icon?: ReactNode
	shortcut?: string
}

type CommandPaletteProps = {
	items: CommandItem[]
	placeholder?: string
	onSelect?: (item: CommandItem) => void
	onClose?: () => void
	label?: string
	autoFocus?: boolean
}

const { blur, duration, ease, spring } = motionTokens
const enter: Transition = { duration: duration.standard, ease: [...ease.enter] }
const leave: Transition = { duration: duration.instant, ease: [...ease.standard] }
const GLIDE_ROWS = 6
// Rows fade out while the rest glide into their place; when the list snaps they leave at once so nothing overlaps the new rows.
const rowExit: Variants = {
	exit: (glide: boolean) => ({ opacity: 0, transition: glide ? leave : { duration: 0 } }),
}

export function CommandPalette({
	items,
	placeholder = 'Search commands',
	onSelect,
	onClose,
	label = 'Command palette',
	autoFocus = false,
}: CommandPaletteProps) {
	const inputId = useId()
	const [query, setQuery] = useState('')
	const [activeIndex, setActiveIndex] = useState<number | null>(null)
	const [listHeight, setListHeight] = useState<number | 'auto'>('auto')
	const reduced = useReducedMotion() ?? false
	const inputRef = useRef<HTMLInputElement>(null)
	const listRef = useRef<HTMLDivElement>(null)
	const pointer = useRef(false)
	const lastPointer = useRef({ x: -1, y: -1 })
	const highlightShown = useRef(false)
	const highlightY = useMotionValue(0)
	const highlightHeight = useMotionValue(0)
	const highlightOpacity = useMotionValue(0)

	// A stable list per query: the glide check below runs only when this identity changes.
	const filtered = useMemo(() => {
		const normalized = query.trim().toLowerCase()
		if (!normalized) return items
		return items.filter(item =>
			[item.label, item.description, item.group, ...(item.keywords ?? [])]
				.filter(Boolean)
				.join(' ')
				.toLowerCase()
				.includes(normalized),
		)
	}, [items, query])

	const groups = new Map<string, { item: CommandItem; index: number }[]>()
	filtered.forEach((item, index) => {
		const group = item.group ?? 'Actions'
		groups.set(group, [...(groups.get(group) ?? []), { item, index }])
	})

	// When every remaining row moves within about a viewport, the list closes its gaps with a glide. A long jump snaps like a search result list; only the frame height morphs.
	const [shift, setShift] = useState({ list: filtered, glide: true })
	if (shift.list !== filtered) {
		const before = new Map(shift.list.map((item, index) => [item.id, index]))
		setShift({
			list: filtered,
			glide: filtered.every((item, index) => Math.abs((before.get(item.id) ?? index) - index) <= GLIDE_ROWS),
		})
	}
	const glide = shift.glide && !reduced
	const safeActiveIndex = activeIndex === null ? -1 : Math.min(activeIndex, Math.max(filtered.length - 1, 0))
	const activeId = filtered[safeActiveIndex]?.id

	useEffect(() => {
		if (autoFocus) inputRef.current?.focus({ preventScroll: true })
	}, [autoFocus])

	useEffect(() => {
		const focusShortcut = (event: globalThis.KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault()
				inputRef.current?.focus()
			}
		}
		document.addEventListener('keydown', focusShortcut)
		return () => document.removeEventListener('keydown', focusShortcut)
	}, [])

	// The results frame follows the list height, so filtering closes or opens the gap instead of snapping.
	useLayoutEffect(() => {
		const list = listRef.current
		if (!list) return
		const observer = new ResizeObserver(() => setListHeight(list.offsetHeight))
		observer.observe(list)
		return () => observer.disconnect()
	}, [])

	// One highlight follows the active result: a spring for the pointer, a short slide for arrow keys, a fade when it first appears.
	useLayoutEffect(() => {
		const node = activeId ? document.getElementById(`${inputId}-${activeId}`) : null
		if (!node) {
			highlightShown.current = false
			animate(highlightOpacity, 0, { duration: reduced ? 0 : duration.instant })
			return
		}
		const move: ValueAnimationTransition<number> =
			!highlightShown.current || reduced
				? { duration: 0 }
				: pointer.current
					? spring.snappy
					: { duration: duration.instant, ease: [...ease.enter] }
		// Rows sit inside positioned groups, so their offset is summed up to the list (layout transforms stay out of it).
		let top = 0
		for (
			let element: Element | null = node;
			element instanceof HTMLElement && element !== listRef.current;
			element = element.offsetParent
		) {
			top += element.offsetTop + (element === node ? 0 : element.clientTop)
		}
		animate(highlightY, top, move)
		animate(highlightHeight, node.offsetHeight, move)
		animate(highlightOpacity, 1, { duration: reduced ? 0 : duration.instant })
		highlightShown.current = true
	}, [activeId, inputId, reduced, highlightY, highlightHeight, highlightOpacity])

	useEffect(() => {
		if (!activeId) return
		document.getElementById(`${inputId}-${activeId}`)?.scrollIntoView({ block: 'nearest' })
	}, [activeId, inputId])

	function choose(item: CommandItem) {
		onSelect?.(item)
		setQuery('')
		setActiveIndex(null)
		inputRef.current?.focus()
	}

	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		pointer.current = false
		const last = Math.max(filtered.length - 1, 0)
		if (event.key === 'ArrowDown') {
			event.preventDefault()
			setActiveIndex(index => Math.min((index ?? -1) + 1, last))
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault()
			setActiveIndex(index => Math.max((index ?? filtered.length) - 1, 0))
		}
		if (event.key === 'Home') {
			event.preventDefault()
			setActiveIndex(0)
		}
		if (event.key === 'End') {
			event.preventDefault()
			setActiveIndex(last)
		}
		// Enter runs the highlighted result; after typing, with nothing highlighted yet, it runs the top match.
		const target = filtered[safeActiveIndex] ?? (query ? filtered[0] : undefined)
		if (event.key === 'Enter' && target) {
			event.preventDefault()
			choose(target)
		}
		if (event.key === 'Escape') {
			event.preventDefault()
			if (query) {
				setQuery('')
				setActiveIndex(null)
			} else onClose?.()
		}
	}

	return (
		<motion.div
			className='w-full origin-top overflow-hidden rounded-panel border bg-surface shadow-floating'
			initial={reduced ? false : { opacity: 0, y: 6, scale: 0.98 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			transition={
				reduced
					? { duration: 0 }
					: { default: spring.smooth, opacity: { duration: duration.fast, ease: [...ease.enter] } }
			}
		>
			<div className='relative flex min-h-[54px] items-center gap-2.5 border-b border-border-subtle px-3.5 py-2 transition-[background-color] focus-within:bg-surface-muted max-[480px]:gap-2 max-[480px]:px-[11px]'>
				<span className='grid size-[22px] flex-none place-items-center text-muted'>
					<IconSearch size={18} stroke={1.75} aria-hidden />
				</span>
				<label className='sr-only' htmlFor={inputId}>
					{label}
				</label>
				<input
					ref={inputRef}
					id={inputId}
					role='combobox'
					aria-autocomplete='list'
					aria-expanded='true'
					aria-controls={`${inputId}-results`}
					aria-activedescendant={activeId ? `${inputId}-${activeId}` : undefined}
					value={query}
					onChange={event => {
						setQuery(event.target.value)
						setActiveIndex(null)
					}}
					onKeyDown={handleKeyDown}
					placeholder={placeholder}
					autoComplete='off'
					className='min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground placeholder:text-muted'
				/>
				<AnimatePresence mode='popLayout' initial={false}>
					{query ? (
						<motion.button
							key='clear'
							type='button'
							aria-label='Clear search'
							// Arc lifts the hovered button to the opaque surface over the tinted, focused search row.
							className='grid size-6 flex-none place-items-center rounded-[7px] border-0 bg-transparent text-muted transition-[color,background-color] hover:bg-(--surface) hover:text-foreground active:bg-(--surface) active:text-foreground'
							onClick={() => {
								setQuery('')
								setActiveIndex(null)
								inputRef.current?.focus()
							}}
							initial={reduced ? false : { opacity: 0, scale: 0.6, filter: `blur(${blur.subtle}px)` }}
							animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
							exit={
								reduced
									? { opacity: 0, transition: { duration: 0 } }
									: { opacity: 0, scale: 0.6, filter: `blur(${blur.subtle}px)`, transition: leave }
							}
							transition={
								reduced
									? { duration: 0 }
									: { default: spring.snappy, opacity: { duration: duration.instant } }
							}
						>
							<IconX size={15} aria-hidden />
						</motion.button>
					) : null}
				</AnimatePresence>
				{onClose ? (
					<button
						type='button'
						aria-label='Close command palette'
						className='grid h-6 min-w-[27px] flex-none place-items-center rounded-[7px] border border-border-subtle bg-transparent px-1.5 text-xs leading-none font-medium text-muted transition-[color,background-color] hover:bg-(--surface) hover:text-foreground active:bg-(--surface) active:text-foreground'
						onClick={onClose}
					>
						Esc
					</button>
				) : null}
				<kbd className='inline-flex h-6 min-w-[38px] flex-none items-center justify-center gap-0.5 rounded-[7px] border bg-surface-muted px-1.5 font-sans text-xs leading-none font-medium text-muted tabular-nums max-[480px]:hidden'>
					⌘ K
				</kbd>
			</div>
			<motion.div
				className='overflow-hidden'
				initial={false}
				animate={{ height: listHeight }}
				transition={reduced ? { duration: 0 } : spring.smooth}
			>
				<motion.div
					ref={listRef}
					layoutScroll
					id={`${inputId}-results`}
					role='listbox'
					aria-label='Command results'
					className='relative max-h-[342px] overflow-auto px-2 py-1.5 max-[480px]:p-1.5'
				>
					<motion.span
						aria-hidden
						className='pointer-events-none absolute top-0 right-2 left-2 rounded-[8px] bg-surface-muted max-[480px]:right-1.5 max-[480px]:left-1.5'
						style={{ y: highlightY, height: highlightHeight, opacity: highlightOpacity }}
					/>
					{/* Results leave before the empty state arrives, so the frame makes one height change instead of two. */}
					<AnimatePresence mode='wait' initial={false}>
						{filtered.length ? (
							<motion.div
								key='results'
								initial={reduced ? false : { opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={
									reduced
										? { opacity: 0, transition: { duration: 0 } }
										: { opacity: 0, transition: leave }
								}
								transition={enter}
							>
								{/* Filtered-out rows pop out of the flow as they fade, so the rest glide up and the frame starts closing on the same keystroke. */}
								<AnimatePresence mode='popLayout' initial={false} custom={glide}>
									{[...groups].map(([group, entries]) => (
										<motion.div
											key={group}
											layout={glide ? 'position' : false}
											role='group'
											aria-label={group}
											className='relative [&+&]:mt-1.5'
											variants={rowExit}
											initial={reduced ? false : { opacity: 0 }}
											animate={{ opacity: 1 }}
											exit='exit'
											transition={
												reduced ? { duration: 0 } : { default: enter, layout: spring.smooth }
											}
										>
											<span
												aria-hidden
												className='block px-2 pt-1.5 pb-[3px] text-xs font-medium text-muted'
											>
												{group}
											</span>
											<AnimatePresence mode='popLayout' initial={false} custom={glide}>
												{entries.map(({ item, index }) => (
													<motion.button
														key={item.id}
														layout={glide ? 'position' : false}
														id={`${inputId}-${item.id}`}
														type='button'
														role='option'
														aria-selected={index === safeActiveIndex}
														className='relative flex min-h-[34px] w-full items-center gap-2.5 rounded-[8px] border-0 bg-transparent px-2 text-left text-foreground transition-none max-[480px]:gap-2 max-[340px]:px-1.5'
														onClick={() => choose(item)}
														onPointerMove={event => {
															// Ignore the synthetic moves browsers send while the list scrolls under a still pointer.
															if (
																event.clientX === lastPointer.current.x &&
																event.clientY === lastPointer.current.y
															)
																return
															lastPointer.current = { x: event.clientX, y: event.clientY }
															if (index === safeActiveIndex) return
															pointer.current = true
															setActiveIndex(index)
														}}
														variants={rowExit}
														initial={reduced ? false : { opacity: 0 }}
														animate={{ opacity: 1 }}
														exit='exit'
														transition={
															reduced
																? { duration: 0 }
																: { default: enter, layout: spring.smooth }
														}
													>
														<span
															aria-hidden
															className='grid size-4 flex-none place-items-center text-muted [&_svg]:size-4'
														>
															{item.icon ?? <IconCommand size={16} />}
														</span>
														<span className='flex min-w-0 flex-1 items-baseline gap-2'>
															<strong className='block max-w-full flex-none truncate text-sm font-medium'>
																{item.label}
															</strong>
															{item.description && (
																<small className='block min-w-0 truncate text-xs text-muted'>
																	{item.description}
																</small>
															)}
														</span>
														{item.shortcut && (
															<kbd className='inline-flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-[5px] border border-transparent bg-surface-muted px-1 font-sans text-[11px] leading-none font-medium text-muted tabular-nums max-[480px]:hidden'>
																{item.shortcut}
															</kbd>
														)}
													</motion.button>
												))}
											</AnimatePresence>
										</motion.div>
									))}
								</AnimatePresence>
							</motion.div>
						) : (
							<motion.div
								key='empty'
								initial={reduced ? false : { opacity: 0, y: 6, filter: `blur(${blur.subtle}px)` }}
								animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
								exit={
									reduced
										? { opacity: 0, transition: { duration: 0 } }
										: { opacity: 0, y: -4, transition: leave }
								}
								transition={enter}
							>
								<span className='mb-[5px] grid size-8 place-items-center text-muted'>
									<IconSearch size={20} aria-hidden />
								</span>
								<strong className='text-sm font-medium'>No matching actions</strong>
								<small className='text-xs text-muted'>Try a different word or clear the search.</small>
							</motion.div>
						)}
					</AnimatePresence>
				</motion.div>
			</motion.div>
		</motion.div>
	)
}
