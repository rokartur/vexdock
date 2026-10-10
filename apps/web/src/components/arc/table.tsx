import type { ComponentProps } from 'react'
import { cn } from '@/utils/cn'

/** Arc has no plain table: its sortable-data-table owns its rows and sorting. These are bare elements in its look
 * (header tone, hairlines, hover tint) at dashboard density, for tables whose rows something else (TanStack Table, a
 * virtualizer) owns. Classes merge through `cn`, so a page's `h-8` or `pl-4` replaces the default. */
export function Table({ className, ...props }: ComponentProps<'table'>) {
	return (
		<div className='relative w-full overflow-x-auto'>
			<table
				className={cn('w-full border-separate border-spacing-0 text-left text-sm/(--leading-body)', className)}
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
				'transition-colors duration-(--duration-fast) data-[state=selected]:bg-foreground/5 motion-reduce:transition-none',
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
			className={cn(
				'h-10 border-b border-border px-2 font-medium whitespace-nowrap text-(--text-muted)',
				className,
			)}
			{...props}
		/>
	)
}
export function TableCell({ className, ...props }: ComponentProps<'td'>) {
	return (
		<td
			className={cn(
				'border-b border-(--border-subtle) p-2 align-middle in-[tr:last-child]:border-b-0',
				className,
			)}
			{...props}
		/>
	)
}
