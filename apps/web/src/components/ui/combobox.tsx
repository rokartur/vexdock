import { useState } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { IconCheck, IconChevronDown, IconSearch, IconX } from '@tabler/icons-react'

type Option = { value: string; label: string }

export function Combobox({
	options,
	value,
	onValueChange,
	onCustomValue,
	placeholder,
	emptyMessage,
	disabled,
	'aria-label': ariaLabel,
	'aria-labelledby': ariaLabelledBy,
	'aria-describedby': ariaDescribedBy,
}: {
	options: Option[]
	/** `''` while nothing is picked. */
	value: string
	onValueChange: (value: string) => void
	/** Offers the typed text as a value of its own when no option matches it, for a field whose options are suggestions. */
	onCustomValue?: (value: string) => void
	placeholder: string
	emptyMessage: string
	disabled?: boolean
	'aria-label'?: string
	'aria-labelledby'?: string
	'aria-describedby'?: string
}) {
	const [query, setQuery] = useState('')
	const typed = query.trim()
	const offersTyped = onCustomValue !== undefined && typed !== '' && !options.some(option => option.label === typed)
	// The typed row's value is the text itself, so picking it lands in onValueChange like any option.
	const items = offersTyped ? [{ value: typed, label: `Use "${typed}"` }, ...options] : options
	// A custom value has no option, so it shows as typed.
	const selected = options.find(option => option.value === value) ?? (value ? { value, label: value } : null)

	const pick = (next: Option | null) => {
		if (next === null) return onValueChange('')
		const isOption = options.some(option => option.value === next.value)
		if (isOption || !onCustomValue) onValueChange(next.value)
		else onCustomValue(next.value)
	}

	return (
		<ComboboxPrimitive.Root
			items={items}
			value={selected}
			onValueChange={pick}
			isItemEqualToValue={(item, current) => item.value === current.value}
			onInputValueChange={setQuery}
			onOpenChange={(open, details) => {
				// Leaving a field that takes any value keeps what was typed, as Enter would; Escape still discards it.
				const leaves = details.reason === 'focus-out' || details.reason === 'outside-press'
				if (!open && leaves && offersTyped) pick({ value: typed, label: typed })
			}}
			autoHighlight
			disabled={disabled}
		>
			<ComboboxPrimitive.InputGroup className='flex h-control-md items-center gap-2 rounded-control border border-border-strong bg-surface-muted/50 pr-0.5 pl-2.5 transition-colors focus-within:border-foreground has-disabled:cursor-not-allowed has-disabled:opacity-50'>
				<IconSearch aria-hidden className='size-4 shrink-0 text-muted' />
				<ComboboxPrimitive.Input
					placeholder={placeholder}
					aria-label={ariaLabel}
					aria-labelledby={ariaLabelledBy}
					aria-describedby={ariaDescribedBy}
					className='h-full w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted'
				/>
				<ComboboxPrimitive.Clear
					aria-label='Clear selection'
					className='grid size-7 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-surface-muted hover:text-foreground'
				>
					<IconX aria-hidden className='size-4' />
				</ComboboxPrimitive.Clear>
				<ComboboxPrimitive.Trigger
					aria-label='Open list'
					className='group grid size-7 shrink-0 place-items-center text-muted'
				>
					<IconChevronDown
						aria-hidden
						className='size-4 transition-transform duration-240 ease-standard group-data-popup-open:rotate-180'
					/>
				</ComboboxPrimitive.Trigger>
			</ComboboxPrimitive.InputGroup>
			<ComboboxPrimitive.Portal>
				<ComboboxPrimitive.Positioner className='z-1000' align='start' sideOffset={4} collisionPadding={12}>
					<ComboboxPrimitive.Popup className='w-(--anchor-width) popup overflow-hidden rounded-panel border bg-surface-raised p-1 text-foreground shadow-floating outline-none'>
						<ComboboxPrimitive.Empty className='p-2 text-sm text-muted empty:hidden'>
							{emptyMessage}
						</ComboboxPrimitive.Empty>
						<ComboboxPrimitive.List className='max-h-[min(300px,40vh)] overflow-y-auto overscroll-contain'>
							{(option: Option) => (
								<ComboboxPrimitive.Item
									key={option.value}
									value={option}
									className='flex min-h-8 cursor-default items-center justify-between gap-3 rounded-[calc(var(--radius-panel)-4px)] px-2 text-sm outline-none select-none data-highlighted:bg-surface-muted'
								>
									<span className='min-w-0 truncate'>{option.label}</span>
									<ComboboxPrimitive.ItemIndicator className='inline-flex shrink-0'>
										<IconCheck aria-hidden className='size-4' />
									</ComboboxPrimitive.ItemIndicator>
								</ComboboxPrimitive.Item>
							)}
						</ComboboxPrimitive.List>
					</ComboboxPrimitive.Popup>
				</ComboboxPrimitive.Positioner>
			</ComboboxPrimitive.Portal>
		</ComboboxPrimitive.Root>
	)
}
