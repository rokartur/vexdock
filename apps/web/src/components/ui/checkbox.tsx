import { useId, useState, type ComponentProps } from 'react'
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
import { cn } from 'cn'
import { motion, useReducedMotion, type Transition } from 'motion/react'
import { motionTokens } from '../../lib/motion'

export type CheckboxProps = Omit<ComponentProps<typeof CheckboxPrimitive.Root>, 'className'> & {
	label?: string
	description?: string
	className?: string
}

// Both marks share three points, so the check morphs into the dash and back instead of swapping.
const checkPath = 'M4.25 9.25 L7.25 12.25 L13.75 5.75'
const dashPath = 'M4.75 9 L9 9 L13.25 9'

export function Checkbox({
	label,
	description,
	id,
	className,
	checked,
	defaultChecked,
	indeterminate = false,
	onCheckedChange,
	...props
}: CheckboxProps) {
	const generatedId = useId()
	const controlId = id ?? generatedId
	const reduced = useReducedMotion()
	const [internalChecked, setInternalChecked] = useState(defaultChecked ?? false)
	const isChecked = checked ?? internalChecked
	const on = isChecked || indeterminate
	const fade: Transition = {
		duration: on ? motionTokens.duration.instant : motionTokens.duration.fast,
		ease: motionTokens.ease.standard,
	}

	const change: CheckboxProps['onCheckedChange'] = (next, eventDetails) => {
		if (checked === undefined) setInternalChecked(next)
		onCheckedChange?.(next, eventDetails)
	}

	return (
		<div className='inline-flex min-w-0 items-start'>
			<CheckboxPrimitive.Root
				{...props}
				id={controlId}
				checked={isChecked}
				indeterminate={indeterminate}
				onCheckedChange={change}
				nativeButton
				render={<button type='button' />}
				className={cn(
					'group/press relative grid size-control-md shrink-0 place-items-center rounded-control text-control-glyph disabled:opacity-50',
					className,
				)}
				aria-describedby={description ? `${controlId}-description` : undefined}
				aria-label={props['aria-label'] ?? (label ? undefined : 'Checkbox')}
			>
				{/* The square is the only part that reacts to a press, so the hit area and label never move. */}
				<span
					aria-hidden='true'
					className='relative block size-[18px] rounded-[5px] border border-border-strong bg-surface [transition:scale_400ms_var(--ease-spring),border-color_110ms_var(--ease-standard)] group-active/press:duration-85 group-active/press:ease-standard group-data-checked/press:border-control-on group-data-indeterminate/press:border-control-on group-hover/press:group-data-unchecked/press:border-muted motion-safe:group-active/press:scale-95'
				>
					<motion.span
						className='absolute -inset-px rounded-[inherit] bg-control-on'
						initial={false}
						animate={{ opacity: on ? 1 : 0, scale: on ? 1 : 0.6 }}
						transition={reduced ? { duration: 0 } : { scale: motionTokens.spring.snappy, opacity: fade }}
					/>
					<svg
						className='absolute -inset-px size-[18px] overflow-visible'
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
			{label || description ? (
				// The label's first line centers on the square: (control height - 1.4 line) / 2.
				<div className='ml-px grid min-w-0 gap-0.5 pt-[calc((var(--spacing-control-md)-var(--text-sm)*1.4)/2)]'>
					{label ? (
						<label htmlFor={controlId} className='text-sm font-medium text-foreground'>
							{label}
						</label>
					) : null}
					{description ? (
						<span id={`${controlId}-description`} className='text-xs text-muted'>
							{description}
						</span>
					) : null}
				</div>
			) : null}
		</div>
	)
}
