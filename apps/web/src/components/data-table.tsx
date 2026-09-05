import { Fragment, type ReactNode, useState } from 'react'
import { IconArrowNarrowDown, IconArrowNarrowUp, IconSearch } from '@tabler/icons-react'
import {
	type ColumnDef,
	type RowData,
	type SortingState,
	columnFilteringFeature,
	createColumnHelper,
	createFilteredRowModel,
	createSortedRowModel,
	filterFn_includesString,
	globalFilteringFeature,
	rowSortingFeature,
	sortFn_alphanumeric,
	sortFn_basic,
	sortFn_text,
	tableFeatures,
	useTable,
} from '@tanstack/react-table'
import { Input } from '@/components/ui/input'
import {
	Pagination,
	PaginationContent,
	PaginationItem,
	PaginationNext,
	PaginationPrevious,
} from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { Table as ShadcnTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/utils/cn'
import { EmptyState } from './primitives'

/** Per-column rendering hints the DataTable understands. */
type ColumnMeta = { align?: 'right'; mono?: boolean }

/**
 * One feature set for the whole app: client-side sorting and filtering, nothing
 * else. Paging is a slice of the sorted, filtered rows done by the DataTable
 * itself, which is what lets it clamp the page without an effect.
 */
export const tableFeatureSet = tableFeatures({
	rowSortingFeature,
	sortedRowModel: createSortedRowModel(),
	sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, basic: sortFn_basic },
	columnFilteringFeature,
	globalFilteringFeature,
	filteredRowModel: createFilteredRowModel(),
	filterFns: { includesString: filterFn_includesString },
	columnMeta: {} as ColumnMeta,
})

type Features = typeof tableFeatureSet

/** Column builder bound to the app's feature set: `const cell = columnsFor<Row>()`. */
export function columnsFor<TData extends RowData>() {
	return createColumnHelper<Features, TData>()
}

/**
 * `ColumnDef` is invariant in its value type, so a mixed array of string/number/
 * display columns only type-checks with `any` in that slot. This is the one
 * place it is allowed; every column body stays fully typed through the helper.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type Columns<TData extends RowData> = ColumnDef<Features, TData, any>[]

type DataTableProps<TData extends RowData> = {
	data: TData[]
	columns: Columns<TData>
	loading?: boolean
	/** Shown instead of rows when there is nothing to display. A string becomes the empty state's title. */
	empty?: ReactNode
	getRowId?: (row: TData, index: number) => string
	/** Rows per page. The pager only appears when there is more than one page. */
	pageSize?: number
	/**
	 * A text box above the rows that narrows them to the ones whose accessor
	 * values contain what was typed. The string is the placeholder.
	 */
	filter?: string
	/**
	 * Makes rows expandable: clicking one renders `render` underneath it. Which
	 * row is open belongs to the caller, so it can live in the URL. Needs
	 * `getRowId`, and a cell with its own handler must stop propagation.
	 */
	detail?: {
		openId: string | null
		onOpenChange: (id: string | null) => void
		render: (row: TData) => ReactNode
	}
}

export function DataTable<TData extends RowData>({
	data,
	columns,
	loading = false,
	empty = 'No results',
	getRowId,
	pageSize = 20,
	filter,
	detail,
}: DataTableProps<TData>) {
	const [sorting, setSorting] = useState<SortingState>([])
	const [globalFilter, setGlobalFilter] = useState('')
	const [pageIndex, setPageIndex] = useState(0)

	const table = useTable({
		features: tableFeatureSet,
		columns,
		data,
		getRowId,
		globalFilterFn: 'includesString',
		state: { sorting, globalFilter },
		onSortingChange: setSorting,
		onGlobalFilterChange: setGlobalFilter,
	})

	// Clamp instead of resetting in an effect, so removing the last row of the
	// last page never flashes an empty page.
	const visible = table.getSortedRowModel().rows
	const pageCount = Math.max(1, Math.ceil(visible.length / pageSize))
	const safePageIndex = Math.min(pageIndex, pageCount - 1)
	const rows = visible.slice(safePageIndex * pageSize, (safePageIndex + 1) * pageSize)
	const columnCount = table.getAllLeafColumns().length

	return (
		/* The table is a card: hairline border for the outer edge, rows separated by their own hairlines.
		   overflow-hidden clips the edge-to-edge sticky header background at the rounded corners. */
		<div className='overflow-hidden rounded-xl border bg-card raised'>
			{filter ? (
				<div className='relative border-b border-rule'>
					<IconSearch className='pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
					<Input
						value={globalFilter}
						onChange={event => {
							setGlobalFilter(event.target.value)
							setPageIndex(0)
						}}
						placeholder={filter}
						aria-label={filter}
						className='h-9 rounded-none border-0 bg-transparent pl-9 text-body focus-visible:ring-0 md:text-body dark:bg-transparent'
					/>
				</div>
			) : null}
			{/* Rows and hairlines run edge to edge; the gutter lives in each row's first and last cell. */}
			<div className='max-h-[70vh] overflow-auto'>
				{/* Row separators are the quiet hairline; the card's own edge stays --border. */}
				<ShadcnTable className='text-body [&_tbody_tr]:border-rule [&_td:first-child]:pl-4 [&_th:first-child]:pl-4'>
					<TableHeader>
						{table.getHeaderGroups().map(headerGroup => (
							<TableRow key={headerGroup.id} className='hover:bg-transparent'>
								{headerGroup.headers.map(header => {
									const sorted = header.column.getIsSorted()
									return (
										<TableHead
											key={header.id}
											className={cn(
												// The hairline lives on the th (inset shadow), not the tr border: collapsed
												// tr borders do not travel with sticky cells, which reads as a gap when rows
												// scroll underneath.
												'sticky top-0 z-10 h-8 bg-card pr-3 pl-0 text-label font-medium text-muted-foreground shadow-[inset_0_-1px_0_0_var(--border)]',
												header.column.columnDef.meta?.align === 'right' && 'text-right',
											)}
										>
											{header.isPlaceholder ? null : header.column.getCanSort() ? (
												<button
													type='button'
													onClick={() => header.column.toggleSorting()}
													className='inline-flex cursor-pointer items-center gap-1 transition-colors hover:text-foreground'
												>
													<table.FlexRender header={header} />
													{sorted === 'asc' ? (
														<IconArrowNarrowUp className='size-3' />
													) : sorted === 'desc' ? (
														<IconArrowNarrowDown className='size-3' />
													) : null}
												</button>
											) : (
												<table.FlexRender header={header} />
											)}
										</TableHead>
									)
								})}
							</TableRow>
						))}
					</TableHeader>
					<TableBody>
						{loading ? (
							<SkeletonRows columns={columnCount} />
						) : rows.length === 0 ? (
							<TableRow className='hover:bg-transparent'>
								<TableCell colSpan={columnCount} className='p-0'>
									{typeof empty === 'string' ? (
										<EmptyState title={globalFilter ? 'Nothing matches' : empty} />
									) : (
										empty
									)}
								</TableCell>
							</TableRow>
						) : (
							rows.map(row => {
								const open = detail?.openId === row.id
								return (
									<Fragment key={row.id}>
										{/* An expandable row is the control: focusable, and Enter or
										    Space does what the click does. */}
										<TableRow
											data-state={open ? 'selected' : undefined}
											className={cn(detail && 'cursor-pointer')}
											tabIndex={detail ? 0 : undefined}
											aria-expanded={detail ? open : undefined}
											onClick={detail && (() => detail.onOpenChange(open ? null : row.id))}
											onKeyDown={
												detail &&
												(event => {
													if (event.key !== 'Enter' && event.key !== ' ') return
													event.preventDefault()
													detail.onOpenChange(open ? null : row.id)
												})
											}
										>
											{row.getAllCells().map(cell => (
												<TableCell
													key={cell.id}
													className={cn(
														'h-8 py-0.5 pr-3 pl-0',
														cell.column.columnDef.meta?.align === 'right' && 'text-right',
														cell.column.columnDef.meta?.mono && 'font-mono text-label',
													)}
												>
													<table.FlexRender cell={cell} />
												</TableCell>
											))}
										</TableRow>
										{open && detail ? (
											<TableRow className='hover:bg-transparent'>
												<TableCell colSpan={columnCount} className='p-0'>
													{detail.render(row.original)}
												</TableCell>
											</TableRow>
										) : null}
									</Fragment>
								)
							})
						)}
					</TableBody>
				</ShadcnTable>
			</div>
			{pageCount > 1 && (
				<div className='flex items-center justify-between gap-2 border-t border-rule px-4 py-1.5 text-label text-muted-foreground'>
					<span className='font-mono'>
						{safePageIndex * pageSize + 1}–{Math.min((safePageIndex + 1) * pageSize, visible.length)} of{' '}
						{visible.length}
					</span>
					<Pagination className='mx-0 w-auto'>
						<PaginationContent>
							<PaginationItem>
								{/* The pager links are anchors, so a disabled one is also kept
								    out of the tab order and guarded: Enter on it must not page. */}
								<PaginationPrevious
									href='#'
									aria-disabled={safePageIndex === 0}
									tabIndex={safePageIndex === 0 ? -1 : undefined}
									className='h-7 text-label aria-disabled:pointer-events-none aria-disabled:opacity-40'
									onClick={event => {
										event.preventDefault()
										if (safePageIndex > 0) setPageIndex(safePageIndex - 1)
									}}
								/>
							</PaginationItem>
							<PaginationItem>
								<PaginationNext
									href='#'
									aria-disabled={safePageIndex >= pageCount - 1}
									tabIndex={safePageIndex >= pageCount - 1 ? -1 : undefined}
									className='h-7 text-label aria-disabled:pointer-events-none aria-disabled:opacity-40'
									onClick={event => {
										event.preventDefault()
										if (safePageIndex < pageCount - 1) setPageIndex(safePageIndex + 1)
									}}
								/>
							</PaginationItem>
						</PaginationContent>
					</Pagination>
				</div>
			)}
		</div>
	)
}

function SkeletonRows({ columns, rows = 5 }: { columns: number; rows?: number }) {
	return (
		<>
			{Array.from({ length: rows }, (_row, index) => (
				<TableRow key={index} className='hover:bg-transparent'>
					{Array.from({ length: columns }, (_cell, cell) => (
						<TableCell key={cell} className='h-8 py-0.5 pr-3 pl-0'>
							{/* animate-none: a pulse repaints for as long as the fetch takes. */}
							<Skeleton className='h-3 w-24 animate-none' />
						</TableCell>
					))}
				</TableRow>
			))}
		</>
	)
}
