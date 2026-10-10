'use client'

import { forwardRef } from 'react'
import type { InputHTMLAttributes } from 'react'
import { cn } from '@/utils/cn'

/** Focus answers with the border colour alone (no rings or halos); the field itself never changes size. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
	{ className, ...props },
	ref,
) {
	return (
		<input
			{...props}
			ref={ref}
			className={cn(
				'h-(--control-height-md) w-full rounded-(--radius-control) border border-(--border-strong) bg-(--surface) px-2.5 text-sm/(--leading-body) tracking-(--tracking-body) text-foreground transition-[border-color,background-color] duration-(--duration-fast) ease-(--ease-standard) outline-none placeholder:text-(--text-muted) focus-visible:border-foreground enabled:not-aria-invalid:hover:border-(--text-muted) disabled:cursor-not-allowed disabled:bg-(--surface-muted) disabled:opacity-50 aria-invalid:border-(--danger) motion-reduce:transition-none',
				className,
			)}
		/>
	)
})
