import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { IconArrowNarrowDown, IconArrowNarrowUp, IconFilterOff } from '@tabler/icons-react'
import {
	type ColumnDef,
	type ExpandedState,
	type RowData,
	type SortingState,
	columnFilteringFeature,
	createColumnHelper,
	createExpandedRowModel,
	createFilteredRowModel,
	createSortedRowModel,
	filterFn_includesString,
	globalFilteringFeature,
	rowExpandingFeature,
	rowSortingFeature,
	sortFn_alphanumeric,
	sortFn_basic,
	sortFn_text,
	tableFeatures,
	useTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from 'cn'
import { SearchField } from '@/components/ui/search-field'
import { Table, TableCell, TableHead, TableRow } from '@/components/ui/table'
import { morph } from '@/lib/motion'
import { Button, DetailDialog, EmptyState, ErrorText, LoadingStatus, MoreBelow, textLink, useFill } from './primitives'

type ColumnMeta = { align?: 'right'; mono?: boolean }

/** An h-11 cell plus the row's hairline. Only a guess for rows not yet on screen; each rendered row is measured. */
const ROW_HEIGHT = 45

const OWN_CLICK = 'a, button:not([data-morph-from]), input, label, [role="checkbox"]'

// An alert inside the card sits in a p-2 inset, so its radius is the card's minus that inset, like the filter box.
const insetAlert =
	'mb-0 rounded-[calc(var(--radius-surface)-0.5rem)] in-data-[slot=form-section]:rounded-[max(4px,calc(var(--radius-surface)-28px))]'
/** Client-side sorting, filtering and expanding only. DataTable renders the rows in view itself. */
const tableFeatureSet = tableFeatures({
	rowExpandingFeature,
	expandedRowModel: createExpandedRowModel(),
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
	/** Rows nested under this one. They show once the row's own cell calls `row.toggleExpanded()`, and all of them
	 * while the filter has text, so a match inside a closed row is not hidden. */
	getSubRows?: (row: TData) => TData[] | undefined
	/** Placeholder for a text box above the rows, which keeps the rows whose accessor values contain what was typed. */
	filter?: string
	/** Seeds the filter box, for a page reached with a term already in its URL. */
	initialFilter?: string
	/** Makes the whole row activatable. The cell that names the row renders that name as a `Link` with `tabIndex={-1}`,
	 * so assistive tech finds where it goes; a link or control inside the row keeps its own click. */
	onRowClick?: (row: TData) => void
	/** Clicking a row opens `render` in a dialog titled `title`. The open row belongs to the caller, so it can live in
	 * the URL. The cell that names the row wraps that text in `RowTitle`, and it carries over into the title, so the
	 * title is that same text; the rest of what the row says goes in `description`. */
	detail?: {
		openId: string | null
		onOpenChange: (id: string | null) => void
		title: (row: TData) => string
		description?: (row: TData) => string
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
	// The pill that called this turns `invisible` once the end is in view and drops focus; the region takes it instead.
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
	getSubRows,
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
	const [expanded, setExpanded] = useState<ExpandedState>({})
	// table-core caches accessor values per row and rebuilds rows only on new `data`; an accessor reading outside
	// state (a project name that loads after the list) needs new columns to rebuild them too, so the two change together.
	const model = useMemo(() => ({ columns, data: [...data] }), [data, columns])

	const table = useTable({
		features: tableFeatureSet,
		columns: model.columns,
		data: model.data,
		getRowId,
		getSubRows,
		globalFilterFn: 'includesString',
		// A parent stays when one of its rows matches, and a refetch keeps what the user opened.
		filterFromLeafRows: true,
		autoResetExpanded: false,
		state: { sorting, globalFilter, expanded: globalFilter ? true : expanded },
		onSortingChange: setSorting,
		onExpandedChange: setExpanded,
		onGlobalFilterChange: setGlobalFilter,
	})

	const { rows } = table.getRowModel()
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
		<div
			className={cn(
				// Concentric with the 16 px card around it, 20 px in.
				'overflow-hidden rounded-surface border bg-surface in-data-[slot=form-section]:rounded-[max(6px,calc(var(--radius-surface)-20px))]',
				fill && 'flex min-h-0 flex-1 flex-col',
			)}
		>
			{/* Outside the table: its aria-busy holds back announcements from inside it. */}
			{loading ? <LoadingStatus label='Loading rows' /> : null}
			{filter ? (
				// Concentric with the card: its radius minus this p-2; the resting border one step quieter than a form field's.
				<div className='border-b border-border-subtle p-2 [&_div:has(>input)]:rounded-[calc(var(--radius-surface)-0.5rem)] [&_div:has(>input)]:border-border [&_div:has(>input)]:hover:not-focus-within:border-border-strong'>
					<SearchField
						label={filter}
						hideLabel
						placeholder={filter}
						value={globalFilter}
						onValueChange={value => {
							setGlobalFilter(value)
							virtualizer.scrollToOffset(0)
						}}
					/>
				</div>
			) : null}
			{/* A failed refetch keeps the last rows, so the error rides above them instead of replacing them. */}
			{error && rows.length > 0 ? (
				<div className='border-b border-border-subtle p-2'>
					<ErrorText error={error} className={insetAlert} />
				</div>
			) : null}
			<div className={cn('relative', fill && 'flex min-h-0 flex-1 flex-col')}>
				<div
					ref={viewport}
					// Focusable only by script, so revealing the end leaves focus here when the pill goes away, and a focused row
					// the virtualizer unmounts hands focus here (lib/focus-rescue.ts), where the arrow keys still scroll.
					tabIndex={-1}
					data-focus-fallback
					className={cn(
						// Scroll padding keeps a row reached by Tab clear of the sticky header and MoreBelow's band.
						'@container scroll-pt-10 scroll-pb-20 overflow-auto outline-none',
						fill ? 'min-h-0 flex-1' : 'max-h-[70vh]',
					)}
				>
					{/* Row separators are the quiet hairline; the card's own edge stays --border. An inline-flex cell that starts
					    with an icon or dot takes its baseline from that box's bottom, so cell content centers instead. */}
					<Table
						// Only the rows in view are in the DOM, so a screen reader is told the full count and each row's place.
						aria-rowcount={rows.length > 0 ? headerRows + rows.length : undefined}
						aria-busy={loading || undefined}
						className='text-sm [&_td>*]:align-middle'
					>
						<thead>
							{table.getHeaderGroups().map((headerGroup, index) => (
								<TableRow key={headerGroup.id} aria-rowindex={index + 1} static>
									{headerGroup.headers.map(header => {
										const sorted = header.column.getIsSorted()
										return (
											<TableHead
												key={header.id}
												aria-sort={
													sorted === 'asc'
														? 'ascending'
														: sorted === 'desc'
															? 'descending'
															: undefined
												}
												className={cn(
													// The hairline lives on the th (inset shadow), not the tr border: collapsed
													// tr borders do not travel with sticky cells, which reads as a gap when rows
													// scroll underneath. The sorted column is Arc's tinted strip, mixed toward the
													// foreground because --surface-muted is translucent and the header is sticky.
													'sticky top-0 z-10 border-b-0 bg-surface shadow-[inset_0_-1px_0_0_var(--border)]',
													sorted &&
														'bg-[color-mix(in_oklab,var(--foreground)_3%,var(--surface))] text-foreground',
													header.column.columnDef.meta?.align === 'right' && 'text-right',
												)}
											>
												{header.isPlaceholder ? null : header.column.getCanSort() ? (
													<button
														type='button'
														onClick={() => header.column.toggleSorting()}
														className='inline-flex h-10 press items-center gap-1.5 hover:text-foreground active:text-foreground'
													>
														<table.FlexRender header={header} />
														{sorted === 'asc' ? (
															<IconArrowNarrowUp stroke={1.75} className='size-3.5' />
														) : sorted === 'desc' ? (
															<IconArrowNarrowDown stroke={1.75} className='size-3.5' />
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
						</thead>
						<tbody>
							{loading ? (
								<SkeletonRows columns={columnCount} />
							) : rows.length === 0 ? (
								<TableRow static>
									<TableCell colSpan={columnCount} className='p-0'>
										{/* Held to the box's visible width (its @container), so a table wider than the box does
										    not center this off screen. */}
										<div className='sticky left-0 w-[100cqw]'>
											{error ? (
												<div className='p-2'>
													<ErrorText error={error} className={insetAlert} />
												</div>
											) : globalFilter ? (
												<EmptyState
													scene='search'
													title='Nothing matches'
													description={`No row contains “${globalFilter}”.`}
												>
													<Button onClick={() => setGlobalFilter('')}>
														<IconFilterOff size={16} stroke={1.75} />
														Clear filter
													</Button>
												</EmptyState>
											) : typeof empty === 'string' ? (
												<EmptyState title={empty} />
											) : (
												empty
											)}
										</div>
									</TableCell>
								</TableRow>
							) : (
								<>
									<SpacerRow height={before} columns={columnCount} />
									{rows.slice(first, last + 1).map((row, offset) => {
										const index = first + offset
										const open = detail?.openId === row.id
										const activate = detail
											? (target: HTMLElement) =>
													morph(target, `detail-${row.id}`, () => detail.onOpenChange(row.id))
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
												// Arc's sortable-data-table marks a clickable row the same way; the Press table gives it a pressed tint.
												className={cn(activate && '[cursor:pointer] active:bg-surface-pressed')}
												tabIndex={activate ? 0 : undefined}
												onClick={
													activate &&
													(event => {
														const { target } = event
														if (!(target instanceof Element)) return
														// React bubbles a click inside a cell's portaled popup (a Confirm) up to this row.
														if (!event.currentTarget.contains(target)) return
														// A link or control inside the row keeps its click; RowTitle is a button
														// for assistive tech only and opens the row like the rest of it.
														if (target.closest(OWN_CLICK)) return
														activate(event.currentTarget)
													})
												}
												onKeyDown={
													activate &&
													(event => {
														// A key pressed on a control inside the row belongs to that control.
														if (event.target !== event.currentTarget) return
														if (event.key !== 'Enter' && event.key !== ' ') return
														event.preventDefault()
														activate(event.currentTarget)
													})
												}
											>
												{row.getAllCells().map(cell => (
													<TableCell
														key={cell.id}
														// One line per row, as Arc's tables: a narrow box scrolls sideways instead of
														// breaking an image name across lines.
														className={cn(
															'whitespace-nowrap',
															cell.column.getIsSorted() &&
																'[--cell-base:color-mix(in_oklab,var(--surface-muted)_60%,transparent)]',
															cell.column.columnDef.meta?.align === 'right' &&
																'text-right',
															cell.column.columnDef.meta?.mono && 'font-mono text-xs',
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
						</tbody>
					</Table>
				</div>
				<MoreBelow count={below} onReveal={() => revealEnd(viewport.current)} />
			</div>
			{detail ? (
				<DetailDialog
					open={openRow !== undefined}
					onOpenChange={next => next || detail.onOpenChange(null)}
					title={openRow === undefined ? '' : detail.title(openRow)}
					description={openRow === undefined ? undefined : detail.description?.(openRow)}
					morph={detail.openId === null ? undefined : `detail-${detail.openId}`}
				>
					{openRow === undefined ? null : detail.render(openRow)}
				</DetailDialog>
			) : null}
		</div>
	)
}

/** The text that names a row with a `detail`. A button so assistive tech can open the row, out of the tab order
 * because the row takes focus, and the text that carries over into the dialog's title. `title` shows it whole where
 * a cell truncates it. */
export function RowTitle({ children, className }: { children: string; className?: string }) {
	return (
		<button
			type='button'
			tabIndex={-1}
			title={children}
			data-morph-from
			className={cn(textLink, 'rounded-[4px] text-left whitespace-nowrap', className)}
		>
			{children}
		</button>
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
				<TableRow key={index} static>
					{Array.from({ length: columns }, (_cell, cell) => (
						<TableCell key={cell}>
							{/* Arc's Skeleton line, held still: a pulsing list would repaint for as long as it loads. */}
							<span className='block h-3 w-24 rounded-full bg-[color-mix(in_oklab,var(--border-strong)_38%,var(--surface))]' />
						</TableCell>
					))}
				</TableRow>
			))}
		</>
	)
}
