'use client'

import { useState } from 'react'
import type { Ref } from 'react'
import { Select as SelectPrimitive } from '@base-ui/react/select'
import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Variants } from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'

export interface SelectProps {
	value?: string
	defaultValue?: string
	onValueChange?: (value: string) => void
	required?: boolean
	disabled?: boolean
	name?: string
	/** Left out when a surrounding <label> names the picker. */
	'aria-label'?: string
	'aria-labelledby'?: string
	'aria-describedby'?: string
	placeholder?: string
	id?: string
	className?: string
	options: { value: string; label: string; disabled?: boolean }[]
	ref?: Ref<HTMLButtonElement>
}

/** The shown value rolls in the direction of the list: a later option rises from below, an earlier one drops from above. */
const valueRoll: Variants = {
	enter: (direction: number) => ({
		opacity: 0,
		y: `${direction * 0.35}em`,
		filter: `blur(${motionTokens.blur.soft}px)`,
	}),
	center: {
		opacity: 1,
		y: 0,
		filter: 'blur(0px)',
		transition: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] },
	},
	exit: (direction: number) => ({
		opacity: 0,
		y: `${direction * -0.3}em`,
		filter: `blur(${motionTokens.blur.subtle}px)`,
		transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] },
	}),
}
/** Reduced motion keeps a short crossfade; the resting state matches valueRoll so server and client markup agree. */
const valueFade: Variants = {
	enter: { opacity: 0 },
	center: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: motionTokens.duration.instant } },
	exit: { opacity: 0, transition: { duration: motionTokens.duration.instant } },
}

export function Select({
	'aria-label': ariaLabel,
	'aria-labelledby': ariaLabelledBy,
	'aria-describedby': ariaDescribedBy,
	placeholder = 'Select an option',
	options,
	id,
	className,
	value,
	defaultValue = '',
	onValueChange,
	ref,
	...rootProps
}: SelectProps) {
	const reduceMotion = useReducedMotion()
	const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
	const currentValue = value ?? uncontrolledValue
	const index = options.findIndex(option => option.value === currentValue)
	const shown = index >= 0 ? options[index]!.label : placeholder
	const [previousIndex, setPreviousIndex] = useState(index)
	const [direction, setDirection] = useState(1)
	if (previousIndex !== index) {
		setPreviousIndex(index)
		setDirection(index > previousIndex ? 1 : -1)
	}

	return (
		<SelectPrimitive.Root
			{...rootProps}
			items={options}
			value={index >= 0 ? currentValue : null}
			onValueChange={next => {
				if (next === null) return
				setUncontrolledValue(next)
				onValueChange?.(next)
			}}
		>
			{/* The popup is placed against this box, so it never scales: press feedback is color only. */}
			<SelectPrimitive.Trigger
				ref={ref}
				id={id}
				aria-label={ariaLabel}
				aria-labelledby={ariaLabelledBy}
				aria-describedby={ariaDescribedBy}
				className={cn(
					'group relative box-border flex min-h-(--control-height-md) w-full cursor-pointer items-center justify-between gap-1.5 rounded-(--radius-control) border border-border bg-(--surface) px-2.5 text-left text-sm text-foreground transition-[border-color,background-color] duration-(--duration-fast) ease-(--ease-standard) not-data-disabled:hover:border-(--border-strong) not-data-disabled:hover:bg-(--surface-muted) focus-visible:border-(--border-strong) not-data-disabled:active:border-(--border-strong) not-data-disabled:active:bg-(--surface-muted) data-disabled:cursor-not-allowed data-disabled:opacity-50 data-popup-open:border-(--border-strong) data-popup-open:bg-(--surface-muted) motion-reduce:transition-none',
					className,
				)}
			>
				{/* Base UI's Value is what assistive tech reads; the visible copy below animates between values. */}
				<SelectPrimitive.Value className='sr-only' placeholder={placeholder} />
				<span className='grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]' aria-hidden='true'>
					<AnimatePresence initial={false} custom={direction}>
						<motion.span
							key={index >= 0 ? `value-${currentValue}` : 'placeholder'}
							className={cn(
								'col-start-1 row-start-1 min-w-0 truncate',
								index < 0 && 'text-(--text-muted)',
							)}
							custom={direction}
							variants={reduceMotion ? valueFade : valueRoll}
							initial='enter'
							animate='center'
							exit='exit'
						>
							{shown}
						</motion.span>
					</AnimatePresence>
				</span>
				<SelectPrimitive.Icon className='inline-flex flex-none text-(--text-muted) [transition:transform_var(--duration-spring)_var(--ease-spring),color_var(--duration-fast)_var(--ease-standard)] group-data-popup-open:rotate-180 motion-reduce:transition-none'>
					<IconChevronDown size={16} stroke={1.75} aria-hidden='true' />
				</SelectPrimitive.Icon>
			</SelectPrimitive.Trigger>
			<SelectPrimitive.Portal>
				<SelectPrimitive.Positioner
					className='z-1000'
					alignItemWithTrigger={false}
					align='start'
					sideOffset={4}
					collisionPadding={12}
				>
					{/* The menu grows from the trigger edge; a close that interrupts the open reverses from where it is. */}
					<SelectPrimitive.Popup
						className={cn(
							'box-border w-max max-w-[min(24rem,calc(100vw-20px))] min-w-(--anchor-width) origin-(--transform-origin) overflow-hidden rounded-(--radius-control) border border-border bg-(--surface-raised) p-1 text-foreground shadow-(--shadow-floating) outline-none [--menu-x:0px] [--menu-y:-6px] [transition:opacity_var(--duration-standard)_var(--ease-enter),transform_var(--duration-standard)_var(--ease-enter)] data-[side=left]:[--menu-x:6px] data-[side=left]:[--menu-y:0px] data-[side=right]:[--menu-x:-6px] data-[side=right]:[--menu-y:0px] data-[side=top]:[--menu-y:6px]',
							'data-starting-style:[transform:translate(var(--menu-x),var(--menu-y))_scale(0.97)] data-starting-style:opacity-0',
							'data-ending-style:[transform:translate(calc(var(--menu-x)*0.5),calc(var(--menu-y)*0.5))_scale(0.98)] data-ending-style:opacity-0 data-ending-style:[transition:opacity_var(--duration-instant)_var(--ease-standard),transform_var(--duration-instant)_var(--ease-standard)]',
							'motion-reduce:[transform:none]! motion-reduce:[transition:opacity_var(--duration-instant)_var(--ease-standard)]!',
						)}
					>
						<SelectPrimitive.List className='max-h-[min(320px,calc(var(--available-height)-10px))] overflow-y-auto overscroll-contain py-0.5'>
							{options.map(option => (
								<SelectPrimitive.Item
									key={option.value}
									value={option.value}
									disabled={option.disabled}
									className='relative flex min-h-7 cursor-default items-center rounded-(--radius-control) pr-8 pl-1.5 text-sm text-foreground transition-colors duration-(--duration-instant) ease-(--ease-standard) outline-none select-none data-disabled:opacity-45 data-highlighted:bg-(--surface-muted) motion-reduce:transition-none'
								>
									<SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
									<SelectPrimitive.ItemIndicator className='absolute right-2 inline-flex items-center text-foreground transition-[opacity,scale,filter] delay-40 duration-(--duration-standard) ease-(--ease-enter) motion-reduce:transition-none starting:scale-60 starting:opacity-0 starting:blur-[2px]'>
										<IconCheck size={16} stroke={1.75} aria-hidden='true' />
									</SelectPrimitive.ItemIndicator>
								</SelectPrimitive.Item>
							))}
						</SelectPrimitive.List>
					</SelectPrimitive.Popup>
				</SelectPrimitive.Positioner>
			</SelectPrimitive.Portal>
		</SelectPrimitive.Root>
	)
}
