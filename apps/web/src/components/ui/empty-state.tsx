import type { ReactNode } from 'react'
import { IconFolder } from '@tabler/icons-react'
import { cn } from 'cn'

export function EmptyState({
	title,
	description,
	action,
	icon,
	className,
	label,
}: {
	title: string
	description?: string
	action?: ReactNode
	icon?: ReactNode
	className?: string
	/** Accessible label for the state region. */
	label?: string
}) {
	return (
		<section
			aria-label={label}
			className={cn('flex w-full flex-col items-center px-4 py-12 text-center', className)}
		>
			<span aria-hidden className='text-muted [&_svg]:size-6'>
				{icon ?? <IconFolder />}
			</span>
			<h3 className='mt-3 text-base font-medium'>{title}</h3>
			{description ? <p className='mt-1 max-w-72 text-sm text-secondary'>{description}</p> : null}
			{action ? <div className='mt-4 flex flex-wrap justify-center gap-2'>{action}</div> : null}
		</section>
	)
}
