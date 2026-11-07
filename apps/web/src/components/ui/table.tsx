import type { ComponentProps } from 'react'
import { cn } from 'cn'

/** Bare table elements for rows something else owns (TanStack Table, a virtualizer), inside the caller's own scroll
 * box. Classes merge through `cn`, so a page's `h-8` or `pl-4` replaces the default. */
export function Table({ className, ...props }: ComponentProps<'table'>) {
	return <table className={cn('w-full border-separate border-spacing-0 text-left text-sm', className)} {...props} />
}

/** `static` turns off the hover tint, for a row that is not a record (empty, loading). The row only names the state;
 * each TableCell paints it. */
export function TableRow({ static: isStatic, className, ...props }: ComponentProps<'tr'> & { static?: boolean }) {
	return <tr className={cn(!isStatic && 'group/row', className)} {...props} />
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
	return (
		<th
			className={cn('h-10 border-b border-border px-3 font-medium whitespace-nowrap text-muted', className)}
			{...props}
		/>
	)
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
	return (
		<td
			className={cn(
				'h-11 border-b border-border-subtle px-3 align-middle in-[tr:last-child]:border-b-0',
				// Arc's per-cell fill: a cell with its own --cell-base (a sorted column) mixes the row's tint in, not over.
				'bg-(--cell-fill) transition-colors [--cell-fill:var(--cell-base,transparent)] motion-reduce:transition-none',
				'group-hover/row:[--cell-fill:color-mix(in_oklab,var(--foreground)_3%,var(--cell-base,transparent))]',
				'group-data-[state=selected]/row:[--cell-fill:color-mix(in_oklab,var(--accent)_8%,var(--cell-base,transparent))]',
				'group-data-[state=selected]/row:group-hover/row:[--cell-fill:color-mix(in_oklab,var(--accent)_11%,var(--cell-base,transparent))]',
				className,
			)}
			{...props}
		/>
	)
}
