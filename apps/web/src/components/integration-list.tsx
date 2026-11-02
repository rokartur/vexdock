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
		<li className='grid min-h-15 min-w-0 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-3 px-5 py-2.5 transition-colors duration-110 not-first:border-t not-first:border-border-subtle hover:bg-surface-muted/55 max-sm:px-4'>
			<Icon className='size-5 text-foreground' stroke={1.75} />
			<div className='grid min-w-0 gap-px'>
				<div className='flex min-w-0 items-baseline gap-2'>
					<h3 className='min-w-0 truncate font-display text-[13px] leading-[1.1] font-medium tracking-[-0.03em]'>
						{name}
					</h3>
					{kind ? <span className='flex-none text-xs text-muted max-sm:hidden'>{kind}</span> : null}
				</div>
				<p className='min-w-0 truncate text-xs text-secondary max-sm:line-clamp-2 max-sm:whitespace-normal'>
					{description}
				</p>
			</div>
			<div className='flex min-w-0 items-center justify-end gap-1'>{children}</div>
		</li>
	)
}
