'use client'

import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
import { motion, useReducedMotion } from 'motion/react'
import type { Transition } from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'

export interface CheckboxProps extends Omit<
	ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
	'checked' | 'defaultChecked' | 'className'
> {
	checked: boolean
	className?: string
}

/** Both marks share three points, so the check morphs into the dash and back instead of swapping. */
const checkPath = 'M4.25 9.25 L7.25 12.25 L13.75 5.75'
const dashPath = 'M4.75 9 L9 9 L13.25 9'

/** Controlled only; an enclosing <label> names it. */
export const Checkbox = forwardRef<HTMLSpanElement, CheckboxProps>(function Checkbox(
	{ className, checked, indeterminate, ...props },
	ref,
) {
	const reduced = useReducedMotion()
	const on = checked || indeterminate === true
	const fade: Transition = {
		duration: on ? motionTokens.duration.instant : motionTokens.duration.fast,
		ease: [...motionTokens.ease.standard],
	}
	return (
		<CheckboxPrimitive.Root
			{...props}
			ref={ref}
			checked={checked}
			indeterminate={indeterminate}
			className={cn(
				'group relative grid size-(--control-height-md) flex-none cursor-pointer place-items-center rounded-(--radius-control) border-0 bg-transparent p-0 text-(--control-glyph) [-webkit-tap-highlight-color:transparent] data-disabled:cursor-not-allowed data-disabled:opacity-50',
				className,
			)}
		>
			{/* The square is the only part that reacts to a press, so the hit area and label never move. */}
			<span
				className='relative block size-4 rounded-sm border border-(--border-strong) bg-(--surface) [transition:border-color_var(--duration-fast)_var(--ease-standard),scale_var(--duration-spring)_var(--ease-spring)] group-data-checked:border-(--control-on) group-data-indeterminate:border-(--control-on) group-not-data-disabled:group-hover:group-data-unchecked:border-(--text-muted) motion-safe:group-not-data-disabled:group-active:scale-95 motion-safe:group-not-data-disabled:group-active:[transition:border-color_var(--duration-fast)_var(--ease-standard),scale_var(--duration-instant)_var(--ease-standard)] motion-reduce:transition-none'
				aria-hidden='true'
			>
				<motion.span
					className='absolute -inset-px rounded-[inherit] bg-(--control-on)'
					initial={false}
					animate={{ opacity: on ? 1 : 0, scale: on ? 1 : 0.6 }}
					transition={reduced ? { duration: 0 } : { scale: motionTokens.spring.snappy, opacity: fade }}
				/>
				<svg
					className='absolute -inset-px size-4 overflow-visible'
					viewBox='0 0 18 18'
					fill='none'
					focusable='false'
				>
					<motion.path
						initial={false}
						animate={{
							d: indeterminate ? dashPath : checkPath,
							pathLength: on ? 1 : 0,
							opacity: on ? 1 : 0,
						}}
						transition={
							reduced
								? { duration: 0 }
								: {
										d: motionTokens.spring.morph,
										pathLength: motionTokens.spring.snappy,
										opacity: fade,
									}
						}
						stroke='currentColor'
						strokeWidth={1.75}
						strokeLinecap='round'
						strokeLinejoin='round'
					/>
				</svg>
			</span>
		</CheckboxPrimitive.Root>
	)
})

Checkbox.displayName = 'Checkbox'
