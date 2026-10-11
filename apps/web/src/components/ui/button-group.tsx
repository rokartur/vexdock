import type { ReactNode } from 'react'
import { Toolbar } from '@base-ui/react/toolbar'
import { Tooltip } from './tooltip'

export type ButtonGroupItem = {
	/** Stable key for the segment. */
	id: string
	/** The accessible name and tooltip. */
	label: string
	icon: ReactNode
	onSelect?: () => void
	/** Makes the segment a toggle (follow, wrap) and draws it held down while true. */
	pressed?: boolean
}

/** Icon actions joined into one surface: a shared border and radius, hairline dividers, no gaps. Base UI's toolbar
 * makes it one tab stop that the arrow keys, Home and End move through. */
export function ButtonGroup({ items, label }: { items: ButtonGroupItem[]; label: string }) {
	return (
		<Toolbar.Root
			aria-label={label}
			className='inline-flex max-w-full [scrollbar-width:none] items-stretch overflow-x-auto rounded-control border bg-surface p-0.5 align-middle text-foreground'
		>
			{items.map(item => (
				<Tooltip key={item.id} content={item.label}>
					<Toolbar.Button
						aria-label={item.label}
						aria-pressed={item.pressed}
						onClick={() => item.onSelect?.()}
						className="relative grid size-[calc(var(--spacing-control-md)-6px)] flex-none cursor-pointer place-items-center rounded-[calc(var(--radius-control)-3px)] transition-colors duration-160 not-first:before:absolute not-first:before:inset-y-2 not-first:before:-left-px not-first:before:w-px not-first:before:bg-border not-first:before:content-[''] hover:bg-surface-muted active:bg-surface-muted aria-pressed:bg-surface-muted [&_svg]:size-4 [&_svg]:stroke-[1.75]"
					>
						{item.icon}
					</Toolbar.Button>
				</Tooltip>
			))}
		</Toolbar.Root>
	)
}
