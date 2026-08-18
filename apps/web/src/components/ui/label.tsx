import { type ComponentProps } from 'react'
import { cn } from '@/utils/cn'

function Label({ className, htmlFor, ...props }: ComponentProps<'label'>) {
	return (
		<label
			htmlFor={htmlFor}
			data-slot='label'
			className={cn(
				'flex items-center gap-2 text-xs/relaxed leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
				className,
			)}
			{...props}
		/>
	)
}

export { Label }
