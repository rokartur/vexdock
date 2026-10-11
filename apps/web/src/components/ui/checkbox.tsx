import type { ComponentProps } from 'react'
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
import { cn } from 'cn'

/** Controlled only; an enclosing <label> names it. The hit area is a full control height, the box 16px. */
export function Checkbox({
	className,
	checked,
	indeterminate,
	...props
}: Omit<ComponentProps<typeof CheckboxPrimitive.Root>, 'checked' | 'defaultChecked' | 'className'> & {
	checked: boolean
	className?: string
}) {
	return (
		<CheckboxPrimitive.Root
			{...props}
			checked={checked}
			indeterminate={indeterminate}
			className={cn(
				'group grid size-control-md shrink-0 cursor-pointer place-items-center rounded-control data-disabled:cursor-not-allowed data-disabled:opacity-50',
				className,
			)}
		>
			<span
				aria-hidden
				className='grid size-4 place-items-center rounded-[calc(var(--radius-control)-6px)] border border-border-strong bg-surface text-control-glyph transition-colors group-data-checked:border-control-on group-data-checked:bg-control-on group-data-indeterminate:border-control-on group-data-indeterminate:bg-control-on group-not-data-disabled:group-hover:group-data-unchecked:border-muted'
			>
				<CheckboxPrimitive.Indicator
					render={(indicatorProps, state) => (
						<svg {...indicatorProps} viewBox='0 0 18 18' fill='none' className='size-4' focusable='false'>
							<path
								d={state.indeterminate ? 'M4.75 9h8.5' : 'M4.25 9.25l3 3 6.5-6.5'}
								stroke='currentColor'
								strokeWidth={1.75}
								strokeLinecap='round'
								strokeLinejoin='round'
							/>
						</svg>
					)}
				/>
			</span>
		</CheckboxPrimitive.Root>
	)
}
