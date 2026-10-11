import type { ComponentProps, ReactNode } from 'react'
import { cn } from 'cn'

const tones = {
	neutral: 'border-border bg-surface-muted text-secondary',
	success: 'border-success/25 bg-success/10 text-success',
	info: 'border-accent/25 bg-accent-subtle text-accent',
	warning: 'border-warning/25 bg-warning/10 text-warning',
	danger: 'border-danger/25 bg-danger/10 text-danger',
} satisfies Record<string, string>

export type BadgeTone = keyof typeof tones

export function Badge({
	tone = 'neutral',
	icon,
	className,
	children,
	...props
}: ComponentProps<'span'> & { tone?: BadgeTone; icon?: ReactNode }) {
	return (
		<span
			{...props}
			className={cn(
				'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap',
				tones[tone],
				className,
			)}
		>
			{icon ? (
				<span aria-hidden className='inline-flex [&_svg]:size-4'>
					{icon}
				</span>
			) : null}
			{children}
		</span>
	)
}
