import type { ComponentProps, ReactNode } from 'react'
import { IconAlertTriangle, IconCheck, IconCircleX, IconInfoCircle } from '@tabler/icons-react'
import { cn } from 'cn'

const tones = {
	info: { icon: IconInfoCircle, className: 'text-accent' },
	success: { icon: IconCheck, className: 'text-success' },
	warning: { icon: IconAlertTriangle, className: 'text-warning' },
	danger: { icon: IconCircleX, className: 'text-danger' },
}

export type AlertTone = keyof typeof tones

export function Alert({
	tone = 'info',
	title,
	children,
	className,
	...props
}: Omit<ComponentProps<'div'>, 'title'> & { tone?: AlertTone; title: string; children?: ReactNode }) {
	const { icon: Icon, className: iconClass } = tones[tone]
	return (
		<div
			{...props}
			role={tone === 'danger' ? 'alert' : 'status'}
			className={cn('flex items-start gap-3 rounded-panel border bg-surface p-3', className)}
		>
			<Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', iconClass)} />
			<div className='min-w-0 flex-1'>
				<strong className='block text-sm font-medium'>{title}</strong>
				{/* A div, not a p: details can be block content (a log in a <pre>). */}
				{children === undefined || children === null || children === false || children === '' ? null : (
					<div className='mt-1 text-xs text-secondary'>{children}</div>
				)}
			</div>
		</div>
	)
}
