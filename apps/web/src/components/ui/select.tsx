import { type Ref, useId, useState } from 'react'
import { Select as SelectPrimitive } from '@base-ui/react/select'
import { IconCheck, IconChevronDown, IconChevronUp } from '@tabler/icons-react'
import { cn } from 'cn'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type SelectOption = { value: string; label: string; disabled?: boolean }

type SelectProps = Omit<
	SelectPrimitive.Root.Props<string>,
	'children' | 'items' | 'value' | 'defaultValue' | 'onValueChange'
> & {
	label: string
	options: SelectOption[]
	description?: string
	placeholder?: string
	id?: string
	className?: string
	value?: string
	defaultValue?: string
	onValueChange?: (value: string) => void
	ref?: Ref<HTMLButtonElement>
	// vexdock: keeps the label for assistive tech only, for a page filter in a toolbar.
	hideLabel?: boolean
}

const { blur, duration, ease } = motionTokens

// The shown value rolls in the direction of the list: a later option rises from below, an earlier one drops from above.
const valueRoll: Variants = {
	enter: (direction: number) => ({
		opacity: 0,
		y: `${direction * 0.35}em`,
		filter: `blur(${blur.soft}px)`,
	}),
	center: {
		opacity: 1,
		y: 0,
		filter: 'blur(0px)',
		transition: { duration: duration.standard, ease: [...ease.enter] },
	},
	exit: (direction: number) => ({
		opacity: 0,
		y: `${direction * -0.3}em`,
		filter: `blur(${blur.subtle}px)`,
		transition: { duration: duration.fast, ease: [...ease.standard] },
	}),
}
const valueFade: Variants = {
	enter: { opacity: 0 },
	center: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: duration.instant } },
	exit: { opacity: 0, transition: { duration: duration.instant } },
}

export function Select({
	label,
	description,
	placeholder = 'Select an option',
	options,
	id,
	className,
	value,
	defaultValue = '',
	onValueChange,
	ref,
	hideLabel,
	...rootProps
}: SelectProps) {
	const generatedId = useId()
	const controlId = id ?? generatedId
	const hintId = description ? `${controlId}-description` : undefined
	const reduceMotion = useReducedMotion()
	const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
	const currentValue = value ?? uncontrolledValue
	const index = options.findIndex(option => option.value === currentValue)
	const shown = currentValue ? (options[index]?.label ?? '') : placeholder
	const [previousIndex, setPreviousIndex] = useState(index)
	const [direction, setDirection] = useState(1)
	if (previousIndex !== index) {
		setPreviousIndex(index)
		setDirection(index > previousIndex ? 1 : -1)
	}

	return (
		<div className='grid min-w-0 gap-2'>
			<label htmlFor={controlId} className={cn('text-sm font-medium', hideLabel && 'sr-only')}>
				{label}
			</label>
			<SelectPrimitive.Root
				{...rootProps}
				items={options}
				value={currentValue || null}
				onValueChange={next => {
					// Base UI reports no selection as null; this API keeps Radix's empty string.
					const nextValue = next ?? ''
					setUncontrolledValue(nextValue)
					onValueChange?.(nextValue)
				}}
				onOpenChangeComplete={open => {
					// Radix refocuses the trigger after the exit with a visible ring, after a pointer close too; Base UI rings only after a keyboard close.
					if (!open) document.getElementById(controlId)?.focus({ preventScroll: true, focusVisible: true })
					rootProps.onOpenChangeComplete?.(open)
				}}
			>
				<SelectPrimitive.Trigger
					ref={ref}
					id={controlId}
					aria-describedby={hintId}
					className={cn(
						'relative flex min-h-control-md w-full items-center justify-between gap-3 rounded-control border border-border bg-surface px-3 text-left text-sm text-foreground transition-[border-color,background-color,box-shadow] duration-110 hover:border-border-strong hover:bg-surface-muted focus-visible:border-border-strong active:border-border-strong active:bg-surface-pressed data-disabled:opacity-50 data-popup-open:border-border-strong data-popup-open:bg-surface-muted',
						className,
					)}
				>
					{/* The real value stays readable for assistive tech; the visible copy below animates between values. */}
					<SelectPrimitive.Value placeholder={placeholder} className='sr-only' />
					<span aria-hidden='true' className='grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]'>
						<AnimatePresence initial={false} custom={direction}>
							<motion.span
								key={currentValue ? `value-${currentValue}` : 'placeholder'}
								data-placeholder={currentValue ? undefined : ''}
								custom={direction}
								variants={reduceMotion ? valueFade : valueRoll}
								initial='enter'
								animate='center'
								exit='exit'
								className='col-start-1 row-start-1 min-w-0 truncate data-placeholder:text-muted'
							>
								{shown}
							</motion.span>
						</AnimatePresence>
					</span>
					<SelectPrimitive.Icon className='inline-flex flex-none text-muted transition-[rotate] duration-400 ease-spring data-popup-open:rotate-180'>
						<IconChevronDown size={16} stroke={1.75} aria-hidden='true' />
					</SelectPrimitive.Icon>
				</SelectPrimitive.Trigger>
				<SelectPrimitive.Portal>
					<SelectPrimitive.Positioner
						alignItemWithTrigger={false}
						sideOffset={4}
						collisionPadding={12}
						className='z-1000'
					>
						<SelectPrimitive.Popup
							finalFocus={false}
							className='flex max-h-[min(320px,var(--available-height))] w-(--anchor-width) origin-(--transform-origin) flex-col rounded-[calc(var(--radius-control)+2px)] border border-border bg-surface-raised p-1.5 text-foreground shadow-floating transition-[opacity,translate,scale] duration-170 ease-enter data-ending-style:-translate-y-0.75 data-ending-style:scale-98 data-ending-style:opacity-0 data-ending-style:duration-85 data-ending-style:ease-standard data-starting-style:-translate-y-1.5 data-starting-style:scale-97 data-starting-style:opacity-0 data-[side=top]:data-ending-style:translate-y-0.75 data-[side=top]:data-starting-style:translate-y-1.5'
						>
							<SelectPrimitive.ScrollUpArrow className='inset-x-0 top-0 z-1 grid h-7 place-items-center bg-surface-raised text-muted'>
								<IconChevronUp size={16} stroke={1.75} aria-hidden='true' />
							</SelectPrimitive.ScrollUpArrow>
							<SelectPrimitive.List className='min-h-0 flex-1 overflow-y-auto py-0.5'>
								{options.map(option => (
									<SelectPrimitive.Item
										key={option.value}
										value={option.value}
										disabled={option.disabled}
										className='relative flex min-h-9 items-center rounded-[calc(var(--radius-control)-4px)] pr-[34px] pl-[11px] text-sm text-foreground transition-colors duration-85 data-disabled:opacity-45 data-highlighted:bg-surface-muted'
									>
										<SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
										<SelectPrimitive.ItemIndicator className='absolute right-2.5 inline-flex items-center text-foreground transition-[opacity,scale,filter] delay-40 duration-170 ease-enter starting:scale-60 starting:opacity-0 starting:blur-[2px]'>
											<IconCheck size={16} stroke={1.75} aria-hidden='true' />
										</SelectPrimitive.ItemIndicator>
									</SelectPrimitive.Item>
								))}
							</SelectPrimitive.List>
							<SelectPrimitive.ScrollDownArrow className='inset-x-0 bottom-0 z-1 grid h-7 place-items-center bg-surface-raised text-muted'>
								<IconChevronDown size={16} stroke={1.75} aria-hidden='true' />
							</SelectPrimitive.ScrollDownArrow>
						</SelectPrimitive.Popup>
					</SelectPrimitive.Positioner>
				</SelectPrimitive.Portal>
			</SelectPrimitive.Root>
			{description && (
				<span id={hintId} className='text-xs text-muted'>
					{description}
				</span>
			)}
		</div>
	)
}
