'use client'

import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { InputHTMLAttributes, KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { IconCheck, IconChevronDown, IconSearch, IconX } from '@tabler/icons-react'
import { animate, AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'

export interface ComboboxOption {
	value: string
	label: string
	disabled?: boolean
	keywords?: string[]
}

export interface ComboboxProps extends Omit<
	InputHTMLAttributes<HTMLInputElement>,
	'value' | 'defaultValue' | 'onChange' | 'placeholder'
> {
	options: ComboboxOption[]
	value?: string
	defaultValue?: string
	onValueChange?: (value: string) => void
	/** Offers the typed text as a value of its own when no option matches it, for a field whose options are suggestions. */
	onCustomValue?: (value: string) => void
	placeholder?: string
	emptyMessage?: string
	className?: string
}

/** The value of the "Use …" row; no real option can carry it. */
const CUSTOM = '\u0000custom'

/** Follows the listbox height with a critically damped spring, so filtering never snaps the menu. */
function AutoHeight({ children, reduceMotion }: { children: ReactNode; reduceMotion: boolean | null }) {
	const innerRef = useRef<HTMLDivElement>(null)
	const [height, setHeight] = useState<number | 'auto'>('auto')
	useEffect(() => {
		const inner = innerRef.current
		if (!inner) return
		const observer = new ResizeObserver(() => setHeight(inner.offsetHeight))
		observer.observe(inner)
		return () => observer.disconnect()
	}, [])
	return (
		<motion.div
			className='overflow-hidden'
			initial={false}
			animate={{ height }}
			transition={reduceMotion ? { duration: 0 } : motionTokens.spring.smooth}
		>
			<div ref={innerRef}>{children}</div>
		</motion.div>
	)
}

export const Combobox = forwardRef<HTMLInputElement, ComboboxProps>(function Combobox(
	{
		onCustomValue,
		options,
		value: controlledValue,
		defaultValue = '',
		onValueChange,
		placeholder = 'Search or select…',
		emptyMessage = 'No matches found',
		id,
		className,
		disabled,
		onFocus,
		...inputProps
	},
	forwardedRef,
) {
	const generatedId = useId()
	const controlId = id ?? generatedId
	const listboxId = `${controlId}-listbox`
	const rootRef = useRef<HTMLDivElement>(null)
	const fieldRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const optionRefs = useRef<Record<string, HTMLDivElement | null>>({})
	const reduceMotion = useReducedMotion()
	const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [activeIndex, setActiveIndex] = useState(-1)
	const selectedValue = controlledValue ?? uncontrolledValue
	const selectedOption = options.find(option => option.value === selectedValue)

	useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement)

	// A chosen label settles into the field: it rises in from below with a soft blur. Clearing fades the
	// placeholder in instead of snapping from the old label.
	const settledValue = useRef(selectedValue)
	useEffect(() => {
		if (settledValue.current === selectedValue) return
		settledValue.current = selectedValue
		const input = inputRef.current
		if (!input || reduceMotion || (selectedValue && open)) return
		const controls = selectedValue
			? animate(
					input,
					{
						opacity: [0, 1],
						y: ['0.35em', '0em'],
						filter: [`blur(${motionTokens.blur.soft}px)`, 'blur(0px)'],
					},
					{ duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] },
				)
			: animate(
					input,
					{ opacity: [0, 1] },
					{ duration: motionTokens.duration.fast, ease: [...motionTokens.ease.enter] },
				)
		return () => controls.complete()
	}, [selectedValue, reduceMotion, open])

	const filteredOptions = useMemo(() => {
		const typed = query.trim()
		const normalizedQuery = typed.toLocaleLowerCase()
		if (!normalizedQuery) return options
		const matches = options.filter(option =>
			[option.label, ...(option.keywords ?? [])].some(term => term.toLocaleLowerCase().includes(normalizedQuery)),
		)
		if (!onCustomValue || options.some(option => option.label === typed)) return matches
		return [{ value: CUSTOM, label: `Use "${typed}"` }, ...matches]
	}, [options, query, onCustomValue])

	const enabledIndices = filteredOptions.reduce<number[]>((indices, option, index) => {
		if (!option.disabled) indices.push(index)
		return indices
	}, [])

	useEffect(() => {
		if (!open) return
		const activeOption = activeIndex >= 0 ? filteredOptions[activeIndex] : undefined
		const option = activeOption ? optionRefs.current[activeOption.value] : null
		const listbox = option?.parentElement
		if (option && listbox) {
			const top = option.offsetTop
			const bottom = top + option.offsetHeight
			if (top < listbox.scrollTop) listbox.scrollTop = top
			else if (bottom > listbox.scrollTop + listbox.clientHeight)
				listbox.scrollTop = bottom - listbox.clientHeight
		}
	}, [activeIndex, filteredOptions, open])

	const choose = (option: ComboboxOption) => {
		if (option.disabled) return
		const chosen = option.value === CUSTOM ? query.trim() : option.value
		if (option.value === CUSTOM) onCustomValue?.(chosen)
		else onValueChange?.(chosen)
		setUncontrolledValue(chosen)
		setQuery('')
		setOpen(false)
		inputRef.current?.focus()
	}

	const clear = (event: ReactMouseEvent<HTMLButtonElement>) => {
		event.preventDefault()
		setUncontrolledValue('')
		onValueChange?.('')
		setQuery('')
		setOpen(true)
		inputRef.current?.focus()
	}

	// Leaving a field that takes any value keeps what was typed, as Enter would; Escape still discards it.
	const leave = () => {
		const typed = query.trim()
		if (open && onCustomValue && typed) {
			const match = options.find(option => option.label === typed && !option.disabled)
			if (match) onValueChange?.(match.value)
			else onCustomValue(typed)
			setUncontrolledValue(match?.value ?? typed)
		}
		setOpen(false)
		setQuery('')
	}

	const openMenu = () => {
		if (disabled) return
		setOpen(true)
		setQuery('')
		setActiveIndex(-1)
	}

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (disabled) return
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault()
			if (!open) {
				openMenu()
				return
			}
			if (!enabledIndices.length) return
			const currentPosition = enabledIndices.indexOf(activeIndex)
			const nextPosition =
				event.key === 'ArrowDown'
					? (currentPosition + 1) % enabledIndices.length
					: (currentPosition - 1 + enabledIndices.length) % enabledIndices.length
			setActiveIndex(enabledIndices[nextPosition]!)
			return
		}
		// Typed text picks the highlighted row, else the exact label, else the first row ("Use …" when shown), so Enter
		// never submits the form with the old value.
		if (event.key === 'Enter' && open && (activeIndex >= 0 || query.trim())) {
			event.preventDefault()
			let index = activeIndex
			if (index < 0)
				index = filteredOptions.findIndex(option => option.label === query.trim() && !option.disabled)
			if (index < 0) index = enabledIndices[0] ?? -1
			const option = filteredOptions[index]
			if (option) choose(option)
			return
		}
		if (event.key === 'Escape' && open) {
			event.preventDefault()
			// The list owns this Escape; without it the dialog around the field closes too.
			event.stopPropagation()
			setOpen(false)
			setQuery('')
			return
		}
	}

	// A custom value has no option, so it shows as typed.
	const inputValue = open ? query : (selectedOption?.label ?? selectedValue)

	// The list renders in a portal anchored to the field, so a card or dialog with overflow never clips it. Focus stays in
	// the input: the list cancels its mousedown, and Base UI counts the portal as inside the dialog it opened from.
	return (
		<PopoverPrimitive.Root
			open={open}
			onOpenChange={(next, details) => {
				if (next) return
				if (details.reason === 'escape-key') {
					setOpen(false)
					setQuery('')
				} else if (
					details.reason === 'outside-press' &&
					!rootRef.current?.contains(details.event.target as Node)
				) {
					leave()
				}
			}}
		>
			<div
				ref={rootRef}
				className='relative min-w-0'
				onBlur={event => {
					if (rootRef.current?.contains(event.relatedTarget as Node | null)) return
					leave()
				}}
			>
				<div
					ref={fieldRef}
					className={cn(
						'relative flex min-h-(--control-height-md) items-center gap-(--space-2) rounded-(--radius-control) border border-border bg-(--surface) px-2.5 text-foreground transition-[border-color,background-color,box-shadow] duration-(--duration-fast) ease-(--ease-standard) focus-within:border-(--accent) focus-within:shadow-[0_0_0_3px_var(--focus-ring)] motion-reduce:transition-none',
						open && 'border-(--border-strong) bg-(--surface-muted)',
						disabled
							? 'cursor-not-allowed opacity-50'
							: 'hover:border-(--border-strong) hover:bg-(--surface-muted)',
						className,
					)}
				>
					<IconSearch className='flex-none text-(--text-muted)' size={16} stroke={1.75} aria-hidden='true' />
					<input
						{...inputProps}
						ref={inputRef}
						id={controlId}
						type='text'
						role='combobox'
						value={inputValue}
						// While searching, the chosen label stays in place as muted placeholder copy instead of vanishing.
						placeholder={selectedOption?.label ?? placeholder}
						disabled={disabled}
						aria-expanded={open}
						aria-controls={open ? listboxId : undefined}
						aria-autocomplete='list'
						aria-activedescendant={
							open && activeIndex >= 0 ? `${controlId}-option-${activeIndex}` : undefined
						}
						onFocus={event => {
							onFocus?.(event)
							openMenu()
						}}
						onClick={openMenu}
						onChange={event => {
							setQuery(event.target.value)
							setOpen(true)
							setActiveIndex(-1)
						}}
						onKeyDown={handleKeyDown}
						className='w-full min-w-0 border-0 bg-transparent p-0 text-sm text-foreground outline-0 placeholder:text-(--text-muted) focus-visible:outline-none'
					/>
					<AnimatePresence initial={false}>
						{selectedValue && !disabled && (
							<motion.button
								type='button'
								className='grid size-[22px] flex-none cursor-pointer place-items-center rounded-(--radius-control) border-0 bg-transparent text-(--text-muted) transition-colors duration-(--duration-fast) ease-(--ease-standard) [--focus-outline-offset:1px] hover:bg-(--surface-muted) hover:text-foreground motion-reduce:transition-none'
								aria-label='Clear selection'
								onMouseDown={event => event.preventDefault()}
								onClick={clear}
								initial={
									reduceMotion
										? { opacity: 0 }
										: { opacity: 0, scale: 0.6, filter: `blur(${motionTokens.blur.subtle}px)` }
								}
								animate={{
									opacity: 1,
									scale: 1,
									filter: 'blur(0px)',
									transition: reduceMotion
										? { duration: motionTokens.duration.instant }
										: {
												...motionTokens.spring.snappy,
												opacity: { duration: motionTokens.duration.fast },
											},
								}}
								exit={{
									opacity: 0,
									...(reduceMotion
										? {}
										: { scale: 0.6, filter: `blur(${motionTokens.blur.subtle}px)` }),
									transition: {
										duration: motionTokens.duration.instant,
										ease: [...motionTokens.ease.standard],
									},
								}}
								whileTap={{
									scale: reduceMotion ? 1 : 0.96,
									transition: {
										duration: motionTokens.duration.instant,
										ease: [...motionTokens.ease.standard],
									},
								}}
							>
								<IconX size={16} stroke={1.75} aria-hidden='true' />
							</motion.button>
						)}
					</AnimatePresence>
					<IconChevronDown
						className={cn(
							'flex-none text-(--text-muted) transition-transform duration-(--duration-spring) ease-(--ease-spring) motion-reduce:transition-none',
							open && 'rotate-180',
						)}
						size={16}
						stroke={1.75}
						aria-hidden='true'
					/>
				</div>
			</div>
			<AnimatePresence initial={false}>
				{open && (
					<PopoverPrimitive.Portal keepMounted>
						<PopoverPrimitive.Positioner
							className='z-90'
							anchor={fieldRef}
							side='bottom'
							align='start'
							sideOffset={4}
							collisionPadding={12}
						>
							<PopoverPrimitive.Popup
								initialFocus={false}
								finalFocus={false}
								role='presentation'
								onMouseDown={event => event.preventDefault()}
								render={
									<motion.div
										className='w-(--anchor-width) origin-(--transform-origin) overflow-hidden rounded-(--radius-control) border border-border bg-(--surface-raised) p-1 text-foreground shadow-(--shadow-floating) will-change-[transform,opacity] outline-none'
										initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
										animate={{
											opacity: 1,
											y: 0,
											scale: 1,
											transition: reduceMotion
												? { duration: motionTokens.duration.instant }
												: {
														...motionTokens.spring.snappy,
														opacity: {
															duration: motionTokens.duration.fast,
															ease: [...motionTokens.ease.enter],
														},
													},
										}}
										exit={{
											opacity: 0,
											...(reduceMotion ? {} : { y: -4, scale: 0.98 }),
											transition: {
												duration: motionTokens.duration.instant,
												ease: [...motionTokens.ease.standard],
											},
										}}
									/>
								}
							>
								<AutoHeight reduceMotion={reduceMotion}>
									<div
										id={listboxId}
										className='relative max-h-[min(300px,40vh)] overflow-y-auto overscroll-contain'
										role='listbox'
										aria-label={`${inputProps['aria-label'] ?? 'Options'} options`}
									>
										{filteredOptions.length ? (
											filteredOptions.map((option, index) => (
												<div
													key={option.value}
													ref={element => {
														optionRefs.current[option.value] = element
													}}
													id={`${controlId}-option-${index}`}
													// Arrow keys move the highlight often, so it changes almost instantly.
													className='flex min-h-7 cursor-pointer items-center justify-between gap-(--space-3) rounded-(--radius-control) px-1.5 text-sm text-foreground transition-colors duration-80 ease-(--ease-standard) outline-none select-none data-active:bg-(--surface-muted) data-disabled:cursor-not-allowed data-disabled:opacity-42 motion-reduce:transition-none'
													data-active={index === activeIndex ? 'true' : undefined}
													data-disabled={option.disabled ? 'true' : undefined}
													role='option'
													aria-selected={option.value === selectedValue}
													aria-disabled={option.disabled || undefined}
													onMouseEnter={() => !option.disabled && setActiveIndex(index)}
													onClick={() => choose(option)}
												>
													<span className='min-w-0 truncate'>{option.label}</span>
													{option.value === selectedValue && (
														<IconCheck
															className='flex-none text-foreground'
															size={16}
															stroke={1.75}
															aria-hidden='true'
														/>
													)}
												</div>
											))
										) : (
											<motion.div
												className='p-(--space-3) text-sm text-(--text-muted)'
												role='status'
												initial={
													reduceMotion
														? false
														: {
																opacity: 0,
																y: 4,
																filter: `blur(${motionTokens.blur.soft}px)`,
															}
												}
												animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
												transition={{
													duration: motionTokens.duration.standard,
													ease: [...motionTokens.ease.enter],
												}}
											>
												{emptyMessage}
											</motion.div>
										)}
									</div>
								</AutoHeight>
							</PopoverPrimitive.Popup>
						</PopoverPrimitive.Positioner>
					</PopoverPrimitive.Portal>
				)}
			</AnimatePresence>
		</PopoverPrimitive.Root>
	)
})

Combobox.displayName = 'Combobox'
