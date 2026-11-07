import type { ReactNode } from 'react'
import type { TablerIcon } from '@tabler/icons-react'

export function IntegrationList({ children }: { children: ReactNode }) {
	return <ul className='overflow-hidden rounded-surface border bg-surface'>{children}</ul>
}

export function IntegrationRow({
	icon: Icon,
	name,
	kind,
	description,
	children,
}: {
	icon: TablerIcon
	name: ReactNode
	kind?: ReactNode
	description: ReactNode
	children?: ReactNode
}) {
	return (
		<li className='grid min-h-15 min-w-0 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-3 px-5 py-2.5 not-first:border-t not-first:border-border-subtle max-sm:px-4'>
			<Icon className='size-5 text-foreground' stroke={1.75} />
			<div className='grid min-w-0 gap-0.5'>
				<div className='flex min-w-0 flex-wrap items-baseline gap-x-2'>
					<h3 className='min-w-0 text-sm font-medium wrap-anywhere'>{name}</h3>
					{kind ? <span className='min-w-0 text-xs wrap-anywhere text-muted'>{kind}</span> : null}
				</div>
				<p className='min-w-0 text-xs wrap-anywhere text-secondary'>{description}</p>
			</div>
			<div className='flex min-w-0 items-center justify-end gap-1'>{children}</div>
		</li>
	)
}
