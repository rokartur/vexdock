import type { ComponentProps } from 'react'
import { cn } from 'cn'

/** Bare table elements for rows something else owns (TanStack Table, a virtualizer). Classes merge through `cn`, so a
 * page's `h-8` or `pl-4` replaces the default. */
export function Table({ className, ...props }: ComponentProps<'table'>) {
	return (
		<div className='relative w-full overflow-x-auto'>
			<table
				className={cn('w-full border-separate border-spacing-0 text-left text-sm/[1.4]', className)}
				{...props}
			/>
		</div>
	)
}

export function TableHeader(props: ComponentProps<'thead'>) {
	return <thead {...props} />
}

export function TableBody(props: ComponentProps<'tbody'>) {
	return <tbody {...props} />
}

/** `static` turns off the hover tint, for a row that is not a record (empty, loading). */
export function TableRow({ static: isStatic, className, ...props }: ComponentProps<'tr'> & { static?: boolean }) {
	return (
		<tr
			className={cn(
				'transition-colors duration-160 data-[state=selected]:bg-foreground/5 motion-reduce:transition-none',
				!isStatic && 'hover:bg-foreground/3',
				className,
			)}
			{...props}
		/>
	)
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
	return (
		<th
			className={cn('h-9.5 border-b border-border px-3.5 font-medium whitespace-nowrap text-muted', className)}
			{...props}
		/>
	)
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
	return (
		<td
			className={cn(
				'h-11 border-b border-border-subtle px-3.5 py-0.5 align-middle in-[tr:last-child]:border-b-0',
				className,
			)}
			{...props}
		/>
	)
}
