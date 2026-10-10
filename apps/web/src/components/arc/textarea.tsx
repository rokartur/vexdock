'use client'

import { forwardRef } from 'react'
import type { TextareaHTMLAttributes } from 'react'
import { cn } from '@/utils/cn'

/** Same focus language as Input: the ring contracts onto the border while it fades in, and the box never changes size. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
	{ className, ...props },
	ref,
) {
	return (
		<textarea
			{...props}
			ref={ref}
			className={cn(
				'min-h-16 w-full resize-y rounded-(--radius-control) border border-(--border-strong) bg-(--surface) px-2.5 py-2 text-sm/(--leading-body) text-foreground shadow-[0_0_0_6px_transparent] transition-[border-color,box-shadow,background-color] duration-(--duration-fast) ease-(--ease-standard) outline-none placeholder:text-(--text-muted) focus-visible:border-foreground focus-visible:shadow-[0_0_0_3px_var(--focus-ring)] enabled:not-aria-invalid:hover:border-(--text-muted) disabled:cursor-not-allowed disabled:bg-(--surface-muted) disabled:opacity-60 aria-invalid:border-(--danger) motion-reduce:transition-none',
				className,
			)}
		/>
	)
})
