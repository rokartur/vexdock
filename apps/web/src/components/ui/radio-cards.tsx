import {
	useEffectEvent,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
	type ComponentProps,
	type KeyboardEvent,
	type ReactNode,
} from 'react'
import { cn } from 'cn'
import { animate, motion, useMotionValue, useReducedMotion, type Transition } from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type RadioCardOption = {
	value: string
	label: ReactNode
	description?: ReactNode
	meta?: ReactNode
	icon?: ReactNode
	disabled?: boolean
	/** Shown in place of the description while the option is disabled. */
	disabledReason?: ReactNode
}

export type RadioCardsProps = Omit<ComponentProps<'div'>, 'onChange' | 'defaultValue'> & {
	options: RadioCardOption[]
	value?: string | null
	defaultValue?: string | null
	onValueChange?: (value: string) => void
	layout?: 'grid' | 'list'
	/** Narrowest a grid column may get before the grid drops a column, in px. */
	minColumnWidth?: number
	/** Renders a hidden input carrying the selected value. */
	name?: string
	required?: boolean
	disabled?: boolean
}

// Arc's ring glide, physical(0.42s, 0.14) with mass 1, at 0.7x.
const glide: Transition = { type: 'spring', visualDuration: 0.294, bounce: 0.14 }

const layouts = {
	grid: {
		root: 'gap-2.5',
		// The body row takes the spare height, so prices share a baseline across a row when a description wraps.
		card: "grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)_auto] px-4 py-3.5 [grid-template-areas:'body_indicator'_'meta_meta']",
		indicator: 'mt-px',
		meta: 'mt-2.5 text-lg',
	},
	list: {
		root: 'grid-cols-[minmax(0,1fr)] gap-2',
		card: "grid-cols-[auto_minmax(0,1fr)_auto] items-center py-[13px] pr-4 pl-3.5 [grid-template-areas:'indicator_body_meta']",
		indicator: '',
		meta: 'font-medium',
	},
}

export function RadioCards({
	options,
	value,
	defaultValue = null,
	onValueChange,
	layout = 'grid',
	minColumnWidth = 180,
	name,
	required,
	disabled = false,
	className,
	style,
	ref,
	...props
}: RadioCardsProps) {
	const reduced = useReducedMotion()
	const uid = useId()
	const rootRef = useRef<HTMLDivElement>(null)
	useImperativeHandle<HTMLDivElement | null, HTMLDivElement | null>(ref, () => rootRef.current)
	const [internal, setInternal] = useState(defaultValue)
	const selected = value === undefined ? internal : value
	const selectedIndex = options.findIndex(option => option.value === selected)
	const usable = (option: RadioCardOption) => !disabled && !option.disabled
	const tabStop = selectedIndex !== -1 && usable(options[selectedIndex]!) ? selectedIndex : options.findIndex(usable)
	const variant = layouts[layout]
	const gridColumns = `repeat(auto-fill, minmax(min(100%, ${minColumnWidth}px), 1fr))`

	const x = useMotionValue(0)
	const y = useMotionValue(0)
	const width = useMotionValue(0)
	const height = useMotionValue(0)
	const opacity = useMotionValue(0)
	const placed = useRef(false)

	// The ring springs to the selected card on a change; a resize only snaps it to the new layout.
	const placeRing = useEffectEvent((spring: boolean) => {
		const card = selectedIndex === -1 ? null : cardAt(selectedIndex)
		if (!card) {
			opacity.set(0)
			placed.current = false
			return
		}
		const box = [card.offsetLeft, card.offsetTop, card.offsetWidth, card.offsetHeight]
		if (spring && placed.current && !reduced) {
			animate(x, box[0], glide)
			animate(y, box[1], glide)
			animate(width, box[2], glide)
			animate(height, box[3], glide)
			opacity.set(1)
			return
		}
		x.jump(box[0]!)
		y.jump(box[1]!)
		width.jump(box[2]!)
		height.jump(box[3]!)
		if (!placed.current && spring && !reduced) {
			opacity.jump(0)
			animate(opacity, 1, {
				duration: motionTokens.duration.fast,
				ease: motionTokens.ease.standard,
			})
		} else opacity.jump(1)
		placed.current = true
	})

	useLayoutEffect(() => placeRing(true), [selectedIndex, reduced])
	useLayoutEffect(() => {
		const root = rootRef.current
		if (!root) return
		const observer = new ResizeObserver(() => placeRing(false))
		observer.observe(root)
		return () => observer.disconnect()
	}, [])

	const select = (next: string) => {
		if (next === selected) return
		if (value === undefined) setInternal(next)
		onValueChange?.(next)
	}

	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
		const { key } = event
		if (key === ' ' || key === 'Enter') {
			event.preventDefault()
			if (usable(options[index]!)) select(options[index]!.value)
			return
		}
		let step = 0
		if (key === 'ArrowRight' || key === 'ArrowDown') step = 1
		if (key === 'ArrowLeft' || key === 'ArrowUp') step = -1
		if (step === 0 && key !== 'Home' && key !== 'End') return
		event.preventDefault()
		const horizontal = key === 'ArrowLeft' || key === 'ArrowRight'
		if (horizontal && getComputedStyle(event.currentTarget).direction === 'rtl') step = -step
		const count = options.length
		let at = index
		if (key === 'Home') [at, step] = [-1, 1]
		if (key === 'End') [at, step] = [count, -1]
		for (let tries = 0; tries < count; tries++) {
			at = (at + step + count) % count
			if (!usable(options[at]!)) continue
			cardAt(at)?.focus()
			select(options[at]!.value)
			return
		}
	}

	function cardAt(index: number) {
		return rootRef.current?.querySelector<HTMLElement>(`[data-card="${index}"]`)
	}

	return (
		<div
			ref={rootRef}
			role='radiogroup'
			aria-disabled={disabled || undefined}
			aria-required={required || undefined}
			data-layout={layout}
			className={cn('relative grid text-sm text-foreground', variant.root, className)}
			style={{ gridTemplateColumns: layout === 'grid' ? gridColumns : undefined, ...style }}
			{...props}
		>
			<motion.span
				aria-hidden='true'
				className='pointer-events-none absolute top-0 left-0 z-1 rounded-surface border-[1.5px] border-control-on'
				style={{ x, y, width, height, opacity }}
			/>
			{options.map((option, index) => {
				const checked = index === selectedIndex
				const off = !usable(option)
				const labelId = `${uid}-${index}-label`
				const descriptionId = `${uid}-${index}-description`
				const description = off && option.disabledReason ? option.disabledReason : option.description
				return (
					<button
						key={option.value}
						type='button'
						role='radio'
						data-card={index}
						aria-checked={checked}
						aria-disabled={off || undefined}
						aria-labelledby={labelId}
						aria-describedby={description ? descriptionId : undefined}
						tabIndex={index === tabStop ? 0 : -1}
						data-checked={checked || undefined}
						onClick={() => {
							if (!off) select(option.value)
						}}
						onKeyDown={event => onKeyDown(event, index)}
						className={cn(
							'group/card relative grid min-w-0 items-start gap-x-3 gap-y-1 rounded-surface border bg-surface text-start transition-[background-color,border-color] duration-110 ease-standard focus-visible:not-data-checked:border-border-strong focus-visible:not-data-checked:bg-surface-muted aria-disabled:cursor-not-allowed aria-disabled:bg-surface-muted data-checked:bg-[color-mix(in_oklab,var(--control-on)_4%,var(--surface))]',
							'not-data-checked:not-aria-disabled:hover:border-border-strong not-data-checked:not-aria-disabled:active:bg-surface-pressed',
							variant.card,
						)}
					>
						<span
							aria-hidden='true'
							className={cn(
								'grid size-[18px] flex-none place-items-center rounded-full border-[1.5px] border-border-strong transition-[border-color,background-color] duration-110 ease-standard [grid-area:indicator] group-aria-disabled/card:border-border group-data-checked/card:border-control-on group-data-checked/card:bg-control-on',
								variant.indicator,
							)}
						>
							<motion.span
								className='size-1.5 rounded-full bg-control-glyph'
								initial={false}
								animate={{ scale: checked ? 1 : 0 }}
								transition={reduced ? { duration: 0 } : motionTokens.spring.snappy}
							/>
						</span>
						<span className='grid min-w-0 gap-0.5 [grid-area:body]'>
							<span
								id={labelId}
								className='flex min-w-0 items-center gap-2 font-medium group-aria-disabled/card:text-muted'
							>
								{option.icon && (
									<span className='grid size-[18px] flex-none place-items-center text-secondary group-data-checked/card:text-foreground [&>svg]:size-[18px]'>
										{option.icon}
									</span>
								)}
								<span className='min-w-0 truncate'>{option.label}</span>
							</span>
							{description && (
								<span id={descriptionId} className='text-xs text-pretty text-secondary'>
									{description}
								</span>
							)}
						</span>
						{option.meta && (
							<span
								className={cn(
									'whitespace-nowrap text-foreground tabular-nums [grid-area:meta] group-aria-disabled/card:text-muted',
									variant.meta,
								)}
							>
								{option.meta}
							</span>
						)}
					</button>
				)
			})}
			{name && <input type='hidden' name={name} value={selected ?? ''} required={required} />}
		</div>
	)
}
