import type { ComponentProps } from 'react'
import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import { cn } from 'cn'

/** The control alone; an enclosing <label> names it. */
export function Switch({
	className,
	...props
}: Omit<ComponentProps<typeof SwitchPrimitive.Root>, 'className'> & { className?: string }) {
	return (
		<SwitchPrimitive.Root
			{...props}
			className={cn(
				'group inline-flex min-h-control-md shrink-0 cursor-pointer items-center data-disabled:cursor-not-allowed data-disabled:opacity-50',
				className,
			)}
		>
			<span className='flex h-[18px] w-8 items-center rounded-full bg-control-track p-px transition-colors duration-160 ease-standard group-data-checked:bg-control-on group-not-data-disabled:group-hover:group-data-unchecked:bg-control-track-hover'>
				<SwitchPrimitive.Thumb className='size-4 rounded-full bg-control-thumb shadow-thumb transition-[translate,background-color] duration-580 ease-spring data-checked:translate-x-3.5 data-checked:bg-control-thumb-on' />
			</span>
		</SwitchPrimitive.Root>
	)
}
