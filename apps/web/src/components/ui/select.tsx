import { Select as SelectPrimitive } from '@base-ui/react/select'
import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import { cn } from 'cn'

export function Select({
	options,
	value,
	onValueChange,
	placeholder = 'Select an option',
	className,
	id,
	required,
	disabled,
	'aria-label': ariaLabel,
	'aria-labelledby': ariaLabelledBy,
	'aria-describedby': ariaDescribedBy,
}: {
	options: { value: string; label: string; disabled?: boolean }[]
	value: string
	onValueChange: (value: string) => void
	placeholder?: string
	className?: string
	id?: string
	required?: boolean
	disabled?: boolean
	/** Left out when a surrounding <label> names the picker. */
	'aria-label'?: string
	'aria-labelledby'?: string
	'aria-describedby'?: string
}) {
	// A value outside the options (an empty string for "none yet") shows the placeholder.
	const known = options.some(option => option.value === value)
	return (
		<SelectPrimitive.Root
			items={options}
			value={known ? value : null}
			onValueChange={next => {
				if (next !== null) onValueChange(next)
			}}
			required={required}
			disabled={disabled}
		>
			{/* The popup is placed against this box, so a press answers with color, never scale. */}
			<SelectPrimitive.Trigger
				id={id}
				aria-label={ariaLabel}
				aria-labelledby={ariaLabelledBy}
				aria-describedby={ariaDescribedBy}
				className={cn(
					'group flex h-control-md w-full cursor-pointer items-center justify-between gap-1.5 rounded-control border border-border-strong bg-surface-muted/50 px-2.5 text-left text-sm text-foreground transition-colors not-data-disabled:hover:bg-surface-muted data-disabled:cursor-not-allowed data-disabled:opacity-50 data-popup-open:bg-surface-muted',
					className,
				)}
			>
				<SelectPrimitive.Value
					placeholder={placeholder}
					className='min-w-0 flex-1 truncate data-placeholder:text-muted'
				/>
				<SelectPrimitive.Icon className='inline-flex shrink-0 text-muted transition-transform duration-240 ease-standard group-data-popup-open:rotate-180'>
					<IconChevronDown aria-hidden className='size-4' />
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
					<SelectPrimitive.Popup className='w-max max-w-[min(24rem,var(--available-width))] min-w-(--anchor-width) popup overflow-hidden rounded-panel border bg-surface-raised p-1 text-foreground shadow-floating outline-none'>
						<SelectPrimitive.List className='max-h-[min(320px,calc(var(--available-height)-10px))] overflow-y-auto overscroll-contain'>
							{options.map(option => (
								<SelectPrimitive.Item
									key={option.value}
									value={option.value}
									disabled={option.disabled}
									className='relative flex min-h-8 cursor-default items-center rounded-[calc(var(--radius-panel)-4px)] pr-8 pl-2 text-sm outline-none select-none data-disabled:opacity-45 data-highlighted:bg-surface-muted'
								>
									<SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
									<SelectPrimitive.ItemIndicator className='absolute right-2 inline-flex'>
										<IconCheck aria-hidden className='size-4' />
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
