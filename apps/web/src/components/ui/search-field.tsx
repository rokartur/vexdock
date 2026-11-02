import { useId, type ComponentProps } from 'react'
import { IconSearch, IconX } from '@tabler/icons-react'
import { cn } from 'cn'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { motionTokens } from '../../lib/motion'

type SearchFieldProps = Omit<ComponentProps<'input'>, 'type' | 'value'> & {
	label: string
	value: string
	onValueChange: (value: string) => void
	// vexdock: keeps the label for assistive tech only, for a toolbar search whose placeholder says what it does.
	hideLabel?: boolean
}

export function SearchField({ label, value, onValueChange, hideLabel, id, className, ...props }: SearchFieldProps) {
	const generatedId = useId()
	const controlId = id ?? generatedId
	const reduced = useReducedMotion()

	// Clearing returns focus to the field, since the clear button unmounts under the pointer.
	function clear() {
		onValueChange('')
		document.getElementById(controlId)?.focus()
	}

	return (
		<div className='grid min-w-0 gap-1.5'>
			<label className={cn('text-sm font-medium', hideLabel && 'sr-only')} htmlFor={controlId}>
				{label}
			</label>
			<div
				className='group flex min-h-control-md items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 transition-[border-color] duration-110 ease-standard focus-within:border-foreground hover:not-focus-within:border-foreground'
				data-filled={value ? 'true' : undefined}
			>
				<IconSearch
					size={18}
					stroke={1.75}
					aria-hidden='true'
					className='flex-none text-muted transition-colors duration-110 ease-standard group-focus-within:text-foreground group-data-filled:text-foreground'
				/>
				<input
					{...props}
					id={controlId}
					type='search'
					value={value}
					onChange={event => onValueChange(event.target.value)}
					className={cn(
						'w-full min-w-0 border-0 bg-transparent text-sm text-foreground placeholder:text-muted [&::-webkit-search-cancel-button]:appearance-none',
						className,
					)}
				/>
				{/* The clear button has a reserved slot, so the field never changes width when it appears or leaves. */}
				<span className='grid size-6 flex-none place-items-center'>
					<AnimatePresence initial={false}>
						{value ? (
							<motion.button
								key='clear'
								type='button'
								onClick={clear}
								aria-label='Clear search'
								className='grid size-6 flex-none place-items-center rounded-control text-muted transition-colors duration-110 ease-standard hover:bg-surface-muted hover:text-foreground'
								initial={
									reduced
										? { opacity: 0 }
										: { opacity: 0, scale: 0.8, filter: `blur(${motionTokens.blur.subtle}px)` }
								}
								animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
								exit={
									reduced
										? { opacity: 0, transition: { duration: 0 } }
										: {
												opacity: 0,
												scale: 0.8,
												filter: `blur(${motionTokens.blur.subtle}px)`,
												transition: {
													duration: motionTokens.duration.instant,
													ease: motionTokens.ease.standard,
												},
											}
								}
								whileTap={
									reduced
										? undefined
										: {
												scale: 0.96,
												transition: {
													duration: motionTokens.duration.instant,
													ease: motionTokens.ease.standard,
												},
											}
								}
								transition={
									reduced
										? { duration: motionTokens.duration.instant }
										: {
												...motionTokens.spring.snappy,
												opacity: { duration: motionTokens.duration.fast },
												filter: { duration: motionTokens.duration.fast },
											}
								}
							>
								<IconX size={16} stroke={1.75} aria-hidden='true' />
							</motion.button>
						) : null}
					</AnimatePresence>
				</span>
			</div>
		</div>
	)
}
