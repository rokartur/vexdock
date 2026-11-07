import {
	type ComponentProps,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useImperativeHandle,
	useRef,
	useState,
} from 'react'
import { IconCheck, IconChevronDown, IconSearch, IconX } from '@tabler/icons-react'
import { cn } from 'cn'
import { animate, AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type ComboboxOption = {
	value: string
	label: string
	disabled?: boolean
	keywords?: string[]
}

type ComboboxProps = Omit<ComponentProps<'input'>, 'value' | 'defaultValue' | 'onChange' | 'placeholder'> & {
	label: string
	options: ComboboxOption[]
	value?: string
	defaultValue?: string
	onValueChange?: (value: string) => void
	description?: string
	placeholder?: string
	emptyMessage?: string
	// vexdock: offers typed text as a value of its own when no option matches, for a field whose options are suggestions.
	onCustomValue?: (value: string) => void
	// vexdock: keeps the label for assistive tech only, for a control in a table row or a toolbar.
	hideLabel?: boolean
}

const { blur, duration, ease, spring } = motionTokens

export function Combobox({
	label,
	options,
	value: controlledValue,
	defaultValue = '',
	onValueChange,
	description,
	placeholder = 'Search or select…',
	emptyMessage = 'No matches found',
	onCustomValue,
	hideLabel,
	id,
	className,
	disabled,
	onFocus,
	ref,
	...inputProps
}: ComboboxProps) {
	const generatedId = useId()
	const controlId = id ?? generatedId
	const listboxId = `${controlId}-listbox`
	const hintId = description ? `${controlId}-description` : undefined
	const rootRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const optionRefs = useRef<Record<string, HTMLDivElement | null>>({})
	const reduceMotion = useReducedMotion()
	const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [activeIndex, setActiveIndex] = useState(-1)
	const selectedValue = controlledValue ?? uncontrolledValue
	const selectedOption =
		options.find(option => option.value === selectedValue) ??
		(onCustomValue && selectedValue ? { value: selectedValue, label: selectedValue } : undefined)

	useImperativeHandle(ref, () => inputRef.current!, [])

	// A chosen label rises into the field with a soft blur; clearing fades the placeholder in instead.
	const settledValue = useRef(selectedValue)
	useEffect(() => {
		if (settledValue.current === selectedValue) return
		settledValue.current = selectedValue
		const input = inputRef.current
		if (!input || reduceMotion || (selectedValue && open)) return
		const controls = selectedValue
			? animate(
					input,
					{ opacity: [0, 1], y: ['0.35em', '0em'], filter: [`blur(${blur.soft}px)`, 'blur(0px)'] },
					{ duration: duration.standard, ease: [...ease.enter] },
				)
			: animate(input, { opacity: [0, 1] }, { duration: duration.fast, ease: [...ease.enter] })
		return () => controls.complete()
	}, [selectedValue, reduceMotion, open])

	const normalizedQuery = query.trim().toLocaleLowerCase()
	const matches = normalizedQuery
		? options.filter(option =>
				[option.label, ...(option.keywords ?? [])].some(term =>
					term.toLocaleLowerCase().includes(normalizedQuery),
				),
			)
		: options
	const typed = query.trim()
	const offersTyped =
		onCustomValue !== undefined &&
		typed !== '' &&
		!options.some(option => option.label === typed || option.value === typed)
	const filteredOptions = offersTyped ? [{ value: typed, label: `Use "${typed}"` }, ...matches] : matches
	const enabledIndices = filteredOptions.flatMap((option, index) => (option.disabled ? [] : [index]))
	const activeOption = activeIndex >= 0 ? filteredOptions[activeIndex] : undefined

	useEffect(() => {
		if (!open || !activeOption) return
		const option = optionRefs.current[activeOption.value]
		const listbox = option?.parentElement
		if (!option || !listbox) return
		const top = option.offsetTop
		const bottom = top + option.offsetHeight
		if (top < listbox.scrollTop) listbox.scrollTop = top
		else if (bottom > listbox.scrollTop + listbox.clientHeight) {
			listbox.scrollTop = bottom - listbox.clientHeight
		}
	}, [activeOption, open])

	useEffect(() => {
		const root = rootRef.current!
		const handlePointerDown = (event: PointerEvent) => {
			if (event.target instanceof Node && root.contains(event.target)) return
			setOpen(false)
			setQuery('')
		}
		document.addEventListener('pointerdown', handlePointerDown)
		return () => document.removeEventListener('pointerdown', handlePointerDown)
	}, [])

	const choose = (option: ComboboxOption) => {
		if (option.disabled) return
		setUncontrolledValue(option.value)
		if (onCustomValue && !options.some(known => known.value === option.value)) onCustomValue(option.value)
		else onValueChange?.(option.value)
		setQuery('')
		setOpen(false)
		inputRef.current?.focus()
	}

	const clear = () => {
		setUncontrolledValue('')
		onValueChange?.('')
		setQuery('')
		setOpen(true)
		inputRef.current?.focus()
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
		if (event.key === 'Enter' && activeOption && open) {
			event.preventDefault()
			choose(activeOption)
			return
		}
		if (event.key === 'Escape' && open) {
			event.preventDefault()
			setOpen(false)
			setQuery('')
		}
	}

	return (
		<div ref={rootRef} className='relative grid min-w-0 gap-1.5'>
			<label htmlFor={controlId} className={cn('text-sm font-medium', hideLabel && 'sr-only')}>
				{label}
			</label>
			<div
				data-open={open || undefined}
				data-disabled={disabled || undefined}
				className={cn(
					'group/control relative z-2 flex min-h-control-md items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 text-foreground transition-[border-color,background-color,box-shadow] duration-110 ease-standard focus-within:border-accent hover:border-border-strong hover:bg-surface-muted data-disabled:cursor-not-allowed data-disabled:opacity-50 data-open:border-border-strong data-open:bg-surface-muted',
					className,
				)}
			>
				<IconSearch className='shrink-0 text-muted' size={16} stroke={1.75} aria-hidden />
				<input
					{...inputProps}
					ref={inputRef}
					id={controlId}
					type='text'
					role='combobox'
					value={open ? query : (selectedOption?.label ?? '')}
					// While searching, the chosen label stays in place as muted placeholder copy instead of vanishing.
					placeholder={selectedOption?.label ?? placeholder}
					disabled={disabled}
					aria-describedby={hintId}
					aria-expanded={open}
					aria-controls={open ? listboxId : undefined}
					aria-autocomplete='list'
					aria-activedescendant={
						open && activeOption ? `${controlId}-option-${activeOption.value}` : undefined
					}
					className='w-full min-w-0 border-0 bg-transparent p-0 text-sm text-foreground transition-none placeholder:text-muted'
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
				/>
				<AnimatePresence initial={false}>
					{selectedOption && !disabled && (
						// Arc's hover fill here is its control's opaque hover fill, so only the icon color changes.
						<motion.button
							type='button'
							className='grid size-[22px] shrink-0 place-items-center rounded-control text-muted transition-[color] duration-110 ease-standard [--focus-outline-offset:1px] hover:text-foreground'
							aria-label='Clear selection'
							onMouseDown={event => event.preventDefault()}
							onClick={clear}
							initial={
								reduceMotion
									? { opacity: 0 }
									: { opacity: 0, scale: 0.6, filter: `blur(${blur.subtle}px)` }
							}
							animate={{
								opacity: 1,
								scale: 1,
								filter: 'blur(0px)',
								transition: reduceMotion
									? { duration: duration.instant }
									: { ...spring.snappy, opacity: { duration: duration.fast } },
							}}
							exit={{
								opacity: 0,
								...(reduceMotion ? {} : { scale: 0.6, filter: `blur(${blur.subtle}px)` }),
								transition: { duration: duration.instant, ease: [...ease.standard] },
							}}
							whileTap={{
								scale: reduceMotion ? 1 : 0.96,
								transition: { duration: duration.instant, ease: [...ease.standard] },
							}}
						>
							<IconX size={16} stroke={1.75} aria-hidden />
						</motion.button>
					)}
				</AnimatePresence>
				<IconChevronDown
					className='shrink-0 text-muted transition-transform duration-400 ease-spring group-data-open/control:rotate-180'
					size={16}
					stroke={1.75}
					aria-hidden
				/>
			</div>
			{description && (
				<span id={hintId} className='text-xs text-muted'>
					{description}
				</span>
			)}
			<AnimatePresence initial={false}>
				{open && (
					<motion.div
						className='absolute inset-x-0 top-[calc(100%+8px)] z-80 origin-top overflow-hidden rounded-panel border border-border bg-surface-raised p-[5px] text-foreground shadow-floating will-change-[transform,opacity]'
						initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
						animate={{
							opacity: 1,
							y: 0,
							scale: 1,
							transition: reduceMotion
								? { duration: duration.instant }
								: {
										...spring.snappy,
										opacity: { duration: duration.fast, ease: [...ease.enter] },
									},
						}}
						exit={{
							opacity: 0,
							...(reduceMotion ? {} : { y: -4, scale: 0.98 }),
							transition: { duration: duration.instant, ease: [...ease.standard] },
						}}
						role='presentation'
					>
						<AutoHeight reduceMotion={reduceMotion}>
							<div
								id={listboxId}
								className='max-h-[min(300px,40vh)] overflow-y-auto overscroll-contain'
								role='listbox'
								aria-label={`${label} options`}
							>
								{filteredOptions.length ? (
									filteredOptions.map((option, index) => (
										<div
											key={option.value}
											ref={element => {
												optionRefs.current[option.value] = element
											}}
											id={`${controlId}-option-${option.value}`}
											className='flex min-h-9 items-center justify-between gap-2.5 rounded-[calc(var(--radius-panel)-5px)] px-3 text-sm text-foreground transition-[background-color,color] duration-85 ease-standard data-[active=true]:bg-surface-muted data-[disabled=true]:opacity-42'
											data-active={index === activeIndex ? 'true' : undefined}
											data-disabled={option.disabled ? 'true' : undefined}
											role='option'
											aria-selected={option.value === selectedValue}
											aria-disabled={option.disabled || undefined}
											onMouseDown={event => event.preventDefault()}
											onMouseEnter={() => !option.disabled && setActiveIndex(index)}
											onClick={() => choose(option)}
										>
											<span className='min-w-0 truncate'>{option.label}</span>
											{option.value === selectedValue && (
												<IconCheck
													className='shrink-0 text-foreground'
													size={16}
													stroke={1.75}
													aria-hidden
												/>
											)}
										</div>
									))
								) : (
									<motion.div
										className='p-2.5 text-sm text-muted'
										role='status'
										initial={
											reduceMotion ? false : { opacity: 0, y: 4, filter: `blur(${blur.soft}px)` }
										}
										animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
										transition={{ duration: duration.standard, ease: [...ease.enter] }}
									>
										{emptyMessage}
									</motion.div>
								)}
							</div>
						</AutoHeight>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	)
}

// Follows the listbox height with a critically damped spring, so filtering never snaps the menu.
function AutoHeight({ children, reduceMotion }: { children: ReactNode; reduceMotion: boolean | null }) {
	const innerRef = useRef<HTMLDivElement>(null)
	const [height, setHeight] = useState<number | 'auto'>('auto')
	useEffect(() => {
		const inner = innerRef.current!
		const observer = new ResizeObserver(() => setHeight(inner.offsetHeight))
		observer.observe(inner)
		return () => observer.disconnect()
	}, [])
	return (
		<motion.div
			className='overflow-hidden'
			initial={false}
			animate={{ height }}
			transition={reduceMotion ? { duration: 0 } : spring.smooth}
		>
			<div ref={innerRef}>{children}</div>
		</motion.div>
	)
}
