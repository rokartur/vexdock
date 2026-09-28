import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
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
import { useVirtualizer } from '@tanstack/react-virtual'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table as ShadcnTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/utils/cn'
import { DetailDialog, EmptyState, ErrorText, MoreBelow, useFill } from './primitives'

type ColumnMeta = { align?: 'right'; mono?: boolean }

/** An h-8 cell plus the row's hairline. Only a guess for rows not yet on screen; each rendered row is measured. */
const ROW_HEIGHT = 33

/** Client-side sorting and filtering only. DataTable renders the rows in view itself. */
const tableFeatureSet = tableFeatures({
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
	/** A failed query. Shown instead of the empty state, which would otherwise read as "nothing here". */
	error?: unknown
	/** Shown instead of rows when there is nothing to display. A string becomes the empty state's title. */
	empty?: ReactNode
	getRowId?: (row: TData, index: number) => string
	/** Placeholder for a text box above the rows, which keeps the rows whose accessor values contain what was typed. */
	filter?: string
	/** Seeds the filter box, for a page reached with a term already in its URL. */
	initialFilter?: string
	/** Makes the whole row activatable. A cell with its own handler must stop propagation. */
	onRowClick?: (row: TData) => void
	/** Clicking a row opens `render` in a dialog titled `title`. The open row belongs to the caller, so it can live in
	 * the URL. */
	detail?: {
		openId: string | null
		onOpenChange: (id: string | null) => void
		title: (row: TData) => ReactNode
		render: (row: TData) => ReactNode
	}
}

/** Rows ending below the visible part of `ref`: rendered ones past its edge plus every row after the rendered window.
 * `total` (0 while loading) and `lastRendered` are passed in because a moving window swaps rows between the spacers
 * without resizing anything the observer could see. */
function useRowsBelow(ref: RefObject<HTMLDivElement | null>, total: number, lastRendered: number) {
	const [below, setBelow] = useState(0)
	useEffect(() => {
		const viewport = ref.current
		if (!viewport) return
		const measure = () => {
			// The client box, not the border box: a row behind the horizontal scrollbar is not in view. One pixel of
			// slack, so a fractional row height never counts a row that is fully in view.
			const edge = viewport.getBoundingClientRect().top + viewport.clientTop + viewport.clientHeight + 1
			let hidden = 0
			for (const row of viewport.querySelectorAll('tbody tr[data-index]')) {
				if (row.getBoundingClientRect().bottom > edge) hidden += 1
			}
			setBelow(hidden + total - 1 - lastRendered)
		}
		// A scroll fires several times a frame; measure once per frame.
		let frame = 0
		const schedule = () => {
			if (frame) return
			frame = requestAnimationFrame(() => {
				frame = 0
				measure()
			})
		}
		measure()
		viewport.addEventListener('scroll', schedule, { passive: true })
		const resize = new ResizeObserver(schedule)
		resize.observe(viewport)
		if (viewport.firstElementChild) resize.observe(viewport.firstElementChild)
		return () => {
			cancelAnimationFrame(frame)
			viewport.removeEventListener('scroll', schedule)
			resize.disconnect()
		}
	}, [ref, total, lastRendered])
	return below
}

/** Scrolls `viewport` to its end, without the glide for anyone who asked for less motion. */
function revealEnd(viewport: HTMLDivElement | null) {
	if (!viewport) return
	// The pill that called this unmounts once the end is in view; the region keeps focus instead of the document.
	viewport.focus({ preventScroll: true })
	const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
	viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
}

export function DataTable<TData extends RowData>({
	data,
	columns,
	loading = false,
	error,
	empty = 'No results',
	getRowId,
	filter,
	initialFilter = '',
	onRowClick,
	detail,
}: DataTableProps<TData>) {
	// Inside a `fill` Section the table takes the height left to it and scrolls there, instead of capping at 70vh.
	const fill = useFill()
	const [sorting, setSorting] = useState<SortingState>([])
	const viewport = useRef<HTMLDivElement>(null)
	const [globalFilter, setGlobalFilter] = useState(initialFilter)
	// table-core caches accessor values per row and rebuilds rows only on new `data`; an accessor reading outside
	// state (a project name that loads after the list) needs new columns to rebuild them too.
	const tableData = useMemo(() => [...data], [data, columns])

	const table = useTable({
		features: tableFeatureSet,
		columns,
		data: tableData,
		getRowId,
		globalFilterFn: 'includesString',
		state: { sorting, globalFilter },
		onSortingChange: setSorting,
		onGlobalFilterChange: setGlobalFilter,
	})

	const { rows } = table.getSortedRowModel()
	// ponytail: auto column widths follow the rendered rows, so a list longer than its window can shift a column while
	// scrolling; give columns fixed sizes if that shows.
	const count = loading ? 0 : rows.length
	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => viewport.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 10,
	})
	const windowed = virtualizer.getVirtualItems()
	const first = windowed[0]?.index ?? 0
	const last = windowed.at(-1)?.index ?? -1
	// Spacer rows stand in for the rows outside the window, so the scrollbar and the sticky header act as if all were there.
	const before = windowed[0]?.start ?? 0
	const after = virtualizer.getTotalSize() - (windowed.at(-1)?.end ?? 0)
	const headerRows = table.getHeaderGroups().length
	const columnCount = table.getAllLeafColumns().length
	const below = useRowsBelow(viewport, count, last)
	// Looked up in the whole data set, not the window: a row opened from the URL may be scrolled away or filtered out.
	const openRow =
		detail === undefined || detail.openId === null
			? undefined
			: data.find((row, index) => (getRowId ? getRowId(row, index) : String(index)) === detail.openId)

	return (
		/* The table is a card: hairline border for the outer edge, rows separated by their own hairlines.
		   overflow-hidden clips the edge-to-edge sticky header background at the rounded corners. */
		<div className={cn('overflow-hidden rounded-xl border bg-card raised', fill && 'flex min-h-0 flex-1 flex-col')}>
			{filter ? (
				<div className='relative border-b border-rule'>
					<IconSearch className='pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground' />
					<Input
						value={globalFilter}
						onChange={event => {
							setGlobalFilter(event.target.value)
							virtualizer.scrollToOffset(0)
						}}
						placeholder={filter}
						aria-label={filter}
						className='h-9 rounded-none border-0 bg-transparent pl-9 text-body focus-visible:ring-0 md:text-body dark:bg-transparent'
					/>
				</div>
			) : null}
			{/* Rows and hairlines run edge to edge; the gutter lives in each row's first and last cell. */}
			<div className={cn('relative', fill && 'flex min-h-0 flex-1 flex-col')}>
				{/* This scrolls both ways, so shadcn's own overflow-x wrapper is switched off: it would otherwise be the
				    box the sticky header sticks to, and the header would scroll away with the rows. */}
				<div
					ref={viewport}
					// Focusable only by script, so revealing the end leaves focus here when the pill goes away.
					tabIndex={-1}
					className={cn(
						// Scroll padding keeps a row reached by Tab clear of the sticky header and MoreBelow's band.
						'scroll-pt-8 scroll-pb-20 overflow-auto outline-none [&>[data-slot=table-container]]:overflow-visible',
						fill ? 'min-h-0 flex-1' : 'max-h-[70vh]',
					)}
				>
					{/* Row separators are the quiet hairline; the card's own edge stays --border. An inline-flex cell that starts
					    with an icon or dot takes its baseline from that box's bottom, so cell content centres instead. */}
					<ShadcnTable
						// Only the rows in view are in the DOM, so a screen reader is told the full count and each row's place.
						aria-rowcount={rows.length > 0 ? headerRows + rows.length : undefined}
						className='text-body [&_tbody_tr]:border-rule [&_td:first-child]:pl-4 [&_td>*]:align-middle [&_th:first-child]:pl-4'
					>
						<TableHeader>
							{table.getHeaderGroups().map((headerGroup, index) => (
								<TableRow
									key={headerGroup.id}
									aria-rowindex={index + 1}
									className='hover:bg-transparent'
								>
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
														className='inline-flex h-8 items-center gap-1 transition-colors hover:text-foreground'
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
										{error ? (
											<ErrorText error={error} />
										) : typeof empty === 'string' ? (
											<EmptyState title={globalFilter ? 'Nothing matches' : empty} />
										) : (
											empty
										)}
									</TableCell>
								</TableRow>
							) : (
								<>
									<SpacerRow height={before} columns={columnCount} />
									{rows.slice(first, last + 1).map((row, offset) => {
										const index = first + offset
										const open = detail?.openId === row.id
										const activate = detail
											? () => detail.onOpenChange(row.id)
											: onRowClick && (() => onRowClick(row.original))
										return (
											// An activatable row is the control: focusable, and Enter or Space does what the click does.
											// Keyed by row, not recycled by slot: a refetch that shifts the rows would hand an open
											// Confirm to the next row, and Remove would delete that row's container.
											<TableRow
												key={row.id}
												ref={virtualizer.measureElement}
												data-index={index}
												aria-rowindex={headerRows + index + 1}
												data-state={open ? 'selected' : undefined}
												className={cn(activate && 'cursor-pointer')}
												tabIndex={activate ? 0 : undefined}
												onClick={activate}
												onKeyDown={
													activate &&
													(event => {
														// A key pressed on a control inside the row belongs to that control.
														if (event.target !== event.currentTarget) return
														if (event.key !== 'Enter' && event.key !== ' ') return
														event.preventDefault()
														activate()
													})
												}
											>
												{row.getAllCells().map(cell => (
													<TableCell
														key={cell.id}
														className={cn(
															'h-8 py-0.5 pr-3 pl-0',
															cell.column.columnDef.meta?.align === 'right' &&
																'text-right',
															cell.column.columnDef.meta?.mono && 'font-mono text-label',
														)}
													>
														<table.FlexRender cell={cell} />
													</TableCell>
												))}
											</TableRow>
										)
									})}
									<SpacerRow height={after} columns={columnCount} />
								</>
							)}
						</TableBody>
					</ShadcnTable>
				</div>
				<MoreBelow count={below} onReveal={() => revealEnd(viewport.current)} />
			</div>
			{detail ? (
				<DetailDialog
					open={openRow !== undefined}
					onOpenChange={next => next || detail.onOpenChange(null)}
					title={openRow === undefined ? '' : detail.title(openRow)}
				>
					{openRow === undefined ? null : detail.render(openRow)}
				</DetailDialog>
			) : null}
		</div>
	)
}

function SpacerRow({ height, columns }: { height: number; columns: number }) {
	if (height <= 0) return null
	// The td is hidden too because jsx-a11y reads an empty cell as an unlabeled control.
	return (
		<tr aria-hidden>
			<td aria-hidden colSpan={columns} style={{ height }} />
		</tr>
	)
}

function SkeletonRows({ columns, rows = 5 }: { columns: number; rows?: number }) {
	return (
		<>
			{Array.from({ length: rows }, (_row, index) => (
				<TableRow key={index} className='hover:bg-transparent'>
					{Array.from({ length: columns }, (_cell, cell) => (
						<TableCell key={cell} className='h-8 py-0.5 pr-3 pl-0'>
							<Skeleton className='h-3 w-24' />
						</TableCell>
					))}
				</TableRow>
			))}
		</>
	)
}
