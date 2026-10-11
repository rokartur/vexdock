'use client'

import { forwardRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import { IconEye, IconEyeOff } from '@tabler/icons-react'
import { cn } from '@/utils/cn'

/** Arc's PasswordField without its own label (the dashboard's Field names it): the input and a show/hide toggle in one
 * shell. Focus answers with the shell's border; the shell never changes size. */
export const PasswordField = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(
	function PasswordField({ className, ...props }, ref) {
		const [visible, setVisible] = useState(false)
		const Eye = visible ? IconEyeOff : IconEye
		return (
			<div
				className={cn(
					'flex h-(--control-height-md) w-full items-center gap-1 rounded-(--radius-control) border border-(--border-strong) bg-(--surface) pr-[calc((var(--control-height-md)-2px-1.75rem)/2)] pl-2.5 transition-colors duration-(--duration-fast) ease-(--ease-standard) focus-within:border-foreground has-aria-invalid:border-(--danger) has-[input:disabled]:bg-(--surface-muted) has-[input:disabled]:opacity-50 has-[input:enabled:not([aria-invalid=true])]:hover:border-(--text-muted) motion-reduce:transition-none',
					className,
				)}
			>
				<input
					{...props}
					ref={ref}
					type={visible ? 'text' : 'password'}
					className='h-full w-full min-w-0 bg-transparent text-sm/(--leading-body) tracking-(--tracking-body) text-foreground outline-none placeholder:text-(--text-muted) disabled:cursor-not-allowed'
				/>
				<button
					type='button'
					onClick={() => setVisible(current => !current)}
					aria-label={visible ? 'Hide password' : 'Show password'}
					aria-pressed={visible}
					disabled={props.disabled}
					className='grid size-7 shrink-0 place-items-center rounded-[calc(var(--radius-control)-4px)] text-(--text-muted) transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:bg-(--surface-muted) hover:text-foreground active:scale-96 aria-pressed:text-foreground motion-reduce:transition-none'
				>
					<Eye className='size-4' />
				</button>
			</div>
		)
	},
)
