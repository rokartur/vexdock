import { Progress as ProgressPrimitive } from '@base-ui/react/progress'
import { cn } from 'cn'

export function Progress({
	value,
	max = 100,
	className,
	'aria-label': label = 'Progress',
}: {
	value: number
	max?: number
	className?: string
	'aria-label'?: string
}) {
	return (
		<ProgressPrimitive.Root value={value} max={max} aria-label={label} className={cn('group w-full', className)}>
			<ProgressPrimitive.Track className='h-1 overflow-hidden rounded-full bg-surface-muted'>
				<ProgressPrimitive.Indicator className='block h-full rounded-full bg-accent transition-[width,background-color] duration-480 ease-enter group-data-complete:bg-success' />
			</ProgressPrimitive.Track>
		</ProgressPrimitive.Root>
	)
}
