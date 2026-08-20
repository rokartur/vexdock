import { type ReactNode, useState } from 'react'
import { IconArrowNarrowDown, IconArrowNarrowUp } from '@tabler/icons-react'
import {
	type ColumnDef,
	type RowData,
	type SortingState,
	createColumnHelper,
	createSortedRowModel,
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

/** One feature set for the whole app: client-side sorting, nothing else. */
export const tableFeatureSet = tableFeatures({
	rowSortingFeature,
	sortedRowModel: createSortedRowModel(),
	sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, basic: sortFn_basic },
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
}

export function DataTable<TData extends RowData>({
	data,
	columns,
	loading = false,
	empty = 'No results.',
	getRowId,
}: DataTableProps<TData>) {
	const [sorting, setSorting] = useState<SortingState>([])
	const table = useTable({
		features: tableFeatureSet,
		columns,
		data,
		getRowId,
		state: { sorting },
		onSortingChange: setSorting,
	})

	const { rows } = table.getRowModel()
	const columnCount = table.getAllLeafColumns().length

	return (
		/* No box: rows are separated by their own hairlines, like every list in the panel. */
		<div className='overflow-x-auto'>
			<ShadcnTable className='text-body'>
				<TableHeader>
					{table.getHeaderGroups().map(headerGroup => (
						<TableRow key={headerGroup.id} className='hover:bg-transparent'>
							{headerGroup.headers.map(header => {
								const sorted = header.column.getIsSorted()
								return (
									<TableHead
										key={header.id}
										className={cn(
											'h-7 pr-3 pl-0 text-meta tracking-wide text-muted-foreground uppercase',
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
											'py-1.5 pr-3 pl-0',
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
	)
}

function SkeletonRows({ columns, rows = 5 }: { columns: number; rows?: number }) {
	return (
		<>
			{Array.from({ length: rows }, (_row, index) => (
				<TableRow key={index} className='hover:bg-transparent'>
					{Array.from({ length: columns }, (_cell, cell) => (
						<TableCell key={cell} className='py-1.5 pr-3 pl-0'>
							<div className='h-3 w-24 bg-muted' />
						</TableCell>
					))}
				</TableRow>
			))}
		</>
	)
}
