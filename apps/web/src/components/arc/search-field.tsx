'use client'
import { forwardRef, useId, useRef } from 'react'
import type { InputHTMLAttributes } from 'react'
import { IconSearch, IconX } from '@tabler/icons-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/utils/cn'
import { motionTokens } from './motion-tokens'
export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
	label: string
	/** Keeps the label for assistive tech only, for a search box in a toolbar whose placeholder already says what it does. */
	hideLabel?: boolean
	value: string
	onValueChange: (value: string) => void
}
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
	{ label, hideLabel = false, value, onValueChange, id, className, ...props },
	ref,
) {
	const generated = useId()
	const controlId = id ?? generated
	const reduced = useReducedMotion()
	const inputRef = useRef<HTMLInputElement | null>(null)
	const setRefs = (node: HTMLInputElement | null) => {
		inputRef.current = node
		if (typeof ref === 'function') ref(node)
		else if (ref) ref.current = node
	}
	// Clearing returns focus to the field, since the clear button unmounts under the pointer.
	function clear() {
		onValueChange('')
		inputRef.current?.focus()
	}
	return (
		<div className='grid min-w-0 gap-(--space-2)'>
			<label
				htmlFor={controlId}
				className={hideLabel ? 'sr-only' : 'text-sm/(--leading-body) font-medium tracking-(--tracking-body)'}
			>
				{label}
			</label>
			{/* Focus darkens the border; the shell never changes size. */}
			<div
				className='group flex min-h-(--control-height-md) items-center gap-(--space-2) rounded-(--radius-control) border border-(--border-strong) bg-(--surface) px-2.5 transition-colors duration-(--duration-fast) ease-(--ease-standard) focus-within:border-foreground not-focus-within:hover:border-(--text-muted) motion-reduce:transition-none'
				data-filled={value ? 'true' : undefined}
			>
				{/* The glass wakes up with the field: muted at rest, full contrast while searching. */}
				<IconSearch
					size={18}
					stroke={1.75}
					aria-hidden='true'
					className='flex-none text-(--text-muted) transition-colors duration-(--duration-fast) ease-(--ease-standard) group-focus-within:text-foreground group-data-filled:text-foreground motion-reduce:transition-none'
				/>
				<input
					{...props}
					ref={setRefs}
					id={controlId}
					type='search'
					value={value}
					onChange={event => onValueChange(event.target.value)}
					className={cn(
						'w-full min-w-0 border-0 bg-transparent text-sm tracking-(--tracking-body) text-foreground outline-0 placeholder:text-(--text-muted) [&::-webkit-search-cancel-button]:hidden',
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
								className='grid size-6 flex-none place-items-center rounded-(--radius-control) border-0 bg-transparent text-(--text-muted) transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:bg-(--surface-muted) hover:text-foreground motion-reduce:transition-none'
								tabIndex={0}
								onClick={clear}
								aria-label='Clear search'
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
													ease: [...motionTokens.ease.standard],
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
													ease: [...motionTokens.ease.standard],
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
})
