import type { HTMLAttributes } from 'react'
import { cn } from '@/utils/cn'

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
	name: string
}

export function Avatar({ name, className, ...props }: AvatarProps) {
	const initials = name
		.trim()
		.split(/\s+/)
		.slice(0, 2)
		.map(part => part[0]?.toUpperCase())
		.join('')
	return (
		<span
			{...props}
			className={cn(
				'relative inline-grid size-6 flex-none place-items-center rounded-md border border-border bg-(--surface-muted) text-[10px] font-medium text-foreground',
				className,
			)}
			role='img'
			aria-label={name}
		>
			<span aria-hidden='true'>{initials}</span>
		</span>
	)
}
