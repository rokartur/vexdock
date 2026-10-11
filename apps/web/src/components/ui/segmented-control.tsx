import type { ReactNode } from 'react'
import { Tabs, TabsList, TabsTrigger } from './tabs'

export type Segment = {
	value: string
	label: string
	/** A leading glyph, such as a brand icon. */
	icon?: ReactNode
	/** Content after the label, such as a count. */
	accessory?: ReactNode
}

/** A view switch of 2 to 5 (or a scrolling row of more) options; selection follows the arrow keys. */
export function SegmentedControl({
	options,
	value,
	onValueChange,
	label,
	className,
}: {
	options: Segment[]
	value: string
	onValueChange: (value: string) => void
	label?: string
	className?: string
}) {
	return (
		<Tabs value={value} onValueChange={next => onValueChange(String(next))} className={className}>
			<TabsList aria-label={label} activateOnFocus>
				{options.map(option => (
					<TabsTrigger key={option.value} value={option.value} className='px-3 data-active:text-foreground'>
						{option.icon}
						{option.label}
						{option.accessory}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	)
}
