import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { IconArrowNarrowDown, IconArrowNarrowUp, IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import {
	type ColumnDef,
	type RowData,
	type SortingState,
	createColumnHelper,
	createPaginatedRowModel,
	createSortedRowModel,
	rowPaginationFeature,
	rowSortingFeature,
	sortFn_alphanumeric,
	sortFn_basic,
	sortFn_text,
	tableFeatures,
	useTable,
} from '@tanstack/react-table'
import { Table as ShadcnTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/utils/cn'

/** Per-column rendering hints the DataTable understands. */
type ColumnMeta = { align?: 'right'; mono?: boolean }

/** One feature set for the whole app: client-side sorting and pagination, nothing else. */
export const tableFeatureSet = tableFeatures({
	rowSortingFeature,
	sortedRowModel: createSortedRowModel(),
	sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, basic: sortFn_basic },
	rowPaginationFeature,
	paginatedRowModel: createPaginatedRowModel(),
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
	/** Shown instead of rows when there is nothing to display. */
	empty?: ReactNode
	getRowId?: (row: TData, index: number) => string
	/** Rows per page. The pager only appears when there is more than one page. */
	pageSize?: number
	/**
	 * Fill the parent's height (parent must be a sized flex column) and derive
	 * the page size from how many rows actually fit, instead of a fixed count.
	 */
	fillHeight?: boolean
}

export function DataTable<TData extends RowData>({
	data,
	columns,
	loading = false,
	empty = 'No results.',
	getRowId,
	pageSize: fixedPageSize = 20,
	fillHeight = false,
}: DataTableProps<TData>) {
	const [sorting, setSorting] = useState<SortingState>([])
	const [pageIndex, setPageIndex] = useState(0)
	const scrollRef = useRef<HTMLDivElement>(null)
	const [fittedPageSize, setFittedPageSize] = useState(fixedPageSize)
	const pageSize = fillHeight ? fittedPageSize : fixedPageSize

	// Fit the page to the container: measure the header and the first rendered
	// row, then keep re-fitting as the container resizes. The container's height
	// comes from the layout (flex-1), not its rows, so this never feeds back.
	useLayoutEffect(() => {
		if (!fillHeight) return
		const container = scrollRef.current
		if (!container) return
		const fit = () => {
			const row = container.querySelector('tbody tr')
			const rowHeight = row instanceof HTMLElement && row.offsetHeight > 0 ? row.offsetHeight : 36
			const headerHeight = container.querySelector('thead')?.getBoundingClientRect().height ?? 32
			setFittedPageSize(Math.max(1, Math.floor((container.clientHeight - headerHeight) / rowHeight)))
		}
		fit()
		const observer = new ResizeObserver(fit)
		observer.observe(container)
		return () => observer.disconnect()
		// data/loading refit: the container never resizes when skeleton rows are
		// swapped for real (taller) rows, so a fit from load time would stick.
	}, [fillHeight, loading, data])

	// Clamp instead of resetting in an effect, so removing the last row of the last page never flashes an empty page.
	const pageCount = Math.max(1, Math.ceil(data.length / pageSize))
	const safePageIndex = Math.min(pageIndex, pageCount - 1)
	const table = useTable({
		features: tableFeatureSet,
		columns,
		data,
		getRowId,
		state: { sorting, pagination: { pageIndex: safePageIndex, pageSize } },
		onSortingChange: setSorting,
	})

	const { rows } = table.getRowModel()
	const columnCount = table.getAllLeafColumns().length

	return (
		/* The box owns the outer edge; rows inside it are separated by their own hairlines.
		   overflow-hidden clips the edge-to-edge sticky header background at the rounded corners. */
		<div className={cn('overflow-hidden rounded-lg border', fillHeight && 'flex min-h-0 flex-1 flex-col')}>
			{/* Rows and hairlines run edge to edge; the gutter lives in each row's first and last cell. */}
			<div ref={scrollRef} className={cn('overflow-auto', fillHeight ? 'min-h-0 flex-1' : 'max-h-[70vh]')}>
				<ShadcnTable className='text-body [&_td:first-child]:pl-3 [&_th:first-child]:pl-3'>
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
												'sticky top-0 z-10 h-8 bg-background pr-3 pl-0 text-meta tracking-wide text-muted-foreground uppercase shadow-[inset_0_-1px_0_0_var(--border)]',
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
								<TableCell colSpan={columnCount} className='h-20 text-center text-muted-foreground'>
									{empty}
								</TableCell>
							</TableRow>
						) : (
							rows.map(row => (
								<TableRow key={row.id}>
									{row.getAllCells().map(cell => (
										<TableCell
											key={cell.id}
											className={cn(
												'py-2 pr-3 pl-0',
												cell.column.columnDef.meta?.align === 'right' && 'text-right',
												cell.column.columnDef.meta?.mono && 'font-mono',
											)}
										>
											<table.FlexRender cell={cell} />
										</TableCell>
									))}
								</TableRow>
							))
						)}
					</TableBody>
				</ShadcnTable>
			</div>
			{pageCount > 1 && (
				<div className='flex items-center justify-end gap-2 border-t px-3 py-1.5 text-meta text-muted-foreground'>
					<span className='font-mono'>
						{safePageIndex * pageSize + 1}–{Math.min((safePageIndex + 1) * pageSize, data.length)} of{' '}
						{data.length}
					</span>
					<PagerButton
						label='Previous page'
						disabled={safePageIndex === 0}
						onClick={() => setPageIndex(safePageIndex - 1)}
					>
						<IconChevronLeft className='size-3.5' />
					</PagerButton>
					<PagerButton
						label='Next page'
						disabled={safePageIndex >= pageCount - 1}
						onClick={() => setPageIndex(safePageIndex + 1)}
					>
						<IconChevronRight className='size-3.5' />
					</PagerButton>
				</div>
			)}
		</div>
	)
}

function PagerButton({
	label,
	disabled,
	onClick,
	children,
}: {
	label: string
	disabled: boolean
	onClick: () => void
	children: ReactNode
}) {
	return (
		<button
			type='button'
			aria-label={label}
			disabled={disabled}
			onClick={onClick}
			className='flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground'
		>
			{children}
		</button>
	)
}

function SkeletonRows({ columns, rows = 5 }: { columns: number; rows?: number }) {
	return (
		<>
			{Array.from({ length: rows }, (_row, index) => (
				<TableRow key={index} className='hover:bg-transparent'>
					{Array.from({ length: columns }, (_cell, cell) => (
						<TableCell key={cell} className='py-2 pr-3 pl-0'>
							<div className='h-3 w-24 rounded-sm bg-muted' />
						</TableCell>
					))}
				</TableRow>
			))}
		</>
	)
}
