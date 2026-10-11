import { useId, useRef } from 'react'
import type { ComponentProps } from 'react'
import { IconSearch, IconX } from '@tabler/icons-react'
import { cn } from 'cn'
import { Button } from './button'

export function SearchField({
	label,
	hideLabel = false,
	value,
	onValueChange,
	id,
	className,
	...props
}: Omit<ComponentProps<'input'>, 'type' | 'value'> & {
	label: string
	/** Keeps the label for assistive tech only, for a toolbar search whose placeholder already says what it does. */
	hideLabel?: boolean
	value: string
	onValueChange: (value: string) => void
}) {
	const generated = useId()
	const controlId = id ?? generated
	const input = useRef<HTMLInputElement>(null)
	return (
		<div className='grid min-w-0 gap-2'>
			<label htmlFor={controlId} className={hideLabel ? 'sr-only' : 'text-sm font-medium'}>
				{label}
			</label>
			<div className='group flex h-control-md items-center gap-2 rounded-control border border-border-strong bg-surface pr-0.5 pl-2.5 transition-colors focus-within:border-foreground not-focus-within:hover:border-muted'>
				<IconSearch
					aria-hidden
					className={cn(
						'size-4 shrink-0 text-muted group-focus-within:text-foreground',
						value && 'text-foreground',
					)}
				/>
				<input
					{...props}
					ref={input}
					id={controlId}
					type='search'
					value={value}
					onChange={event => onValueChange(event.target.value)}
					className={cn(
						'h-full w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden',
						className,
					)}
				/>
				{/* A reserved slot, so the field never changes width when the clear button comes and goes. */}
				<span className='grid size-7 shrink-0 place-items-center'>
					{value ? (
						<Button
							variant='ghost'
							size='sm'
							icon
							aria-label='Clear search'
							onClick={() => {
								onValueChange('')
								// The button unmounts under the pointer, so focus goes back to the field.
								input.current?.focus()
							}}
						>
							<IconX />
						</Button>
					) : null}
				</span>
			</div>
		</div>
	)
}
