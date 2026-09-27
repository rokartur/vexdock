import { useRef, useState } from 'react'
import { IconArrowNarrowDown, IconArrowNarrowUp, IconCircleOff, IconKey } from '@tabler/icons-react'
import { Table as ShadcnTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/utils/cn'
import type { StudioCell } from '../lib/api'
import { Check, IconButton, Input } from './primitives'

/** A console result only knows its column names; a table's columns say the rest. */
export type GridColumn = { name: string; type?: string; nullable?: boolean; primary_key?: boolean; read_only?: boolean }

export type GridRow = {
	id: string
	/** `undefined` is a new row's column left to the database's default. */
	cells: (StudioCell | undefined)[]
	change?: 'insert' | 'delete'
	/** Columns holding an unsaved edit. */
	edited?: ReadonlySet<string>
	/** Absent on a row that cannot be edited. */
	edit?: (column: string, value: StudioCell) => void
	selected?: boolean
	select?: (selected: boolean) => void
}

/** Studio's grid: every cell is text or NULL, a click edits it in place, and unsaved changes keep their colour. */
export function StudioGrid({
	columns,
	rows,
	sort,
	onSort,
}: {
	columns: GridColumn[]
	rows: GridRow[]
	sort?: { column?: string; order?: 'asc' | 'desc' }
	onSort?: (column: string) => void
}) {
	const [editing, setEditing] = useState<{ row: string; column: string }>()
	const selectable = rows.some(row => row.select)

	return (
		<div className='min-h-0 flex-1 overflow-auto [&>[data-slot=table-container]]:overflow-visible'>
			<ShadcnTable className='w-max min-w-full font-mono text-label [&_tbody_tr]:border-rule'>
				<TableHeader>
					<TableRow className='hover:bg-transparent'>
						{selectable ? <TableHead className={cn(headClass, 'w-8 px-2')} /> : null}
						{columns.map(column => {
							const order = sort?.column === column.name ? sort.order : undefined
							const label = (
								<span className='flex flex-col items-start py-1 text-left'>
									<span className='flex items-center gap-1 font-sans text-body font-medium text-foreground'>
										{column.primary_key ? (
											<IconKey aria-label='Primary key' className='size-3 text-warning' />
										) : null}
										{column.name}
										{order === 'asc' ? <IconArrowNarrowUp className='size-3' /> : null}
										{order === 'desc' ? <IconArrowNarrowDown className='size-3' /> : null}
									</span>
									{column.type ? (
										<span className='font-normal'>
											{column.type}
											{column.nullable ? '?' : ''}
										</span>
									) : null}
								</span>
							)
							return (
								<TableHead
									key={column.name}
									aria-sort={
										order === 'asc' ? 'ascending' : order === 'desc' ? 'descending' : undefined
									}
									className={cn(headClass, 'px-3')}
								>
									{onSort ? (
										<button
											type='button'
											onClick={() => onSort(column.name)}
											className='transition-colors hover:text-foreground'
										>
											{label}
										</button>
									) : (
										label
									)}
								</TableHead>
							)
						})}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map(({ select, ...row }) => (
						<TableRow
							key={row.id}
							className={cn(
								row.change === 'insert' && 'bg-success/10 hover:bg-success/15',
								row.change === 'delete' &&
									'bg-destructive/10 text-muted-foreground line-through hover:bg-destructive/15',
							)}
						>
							{selectable ? (
								<TableCell className='w-8 px-2'>
									{select ? (
										<Check
											label=''
											name='Select row'
											checked={row.selected ?? false}
											onChange={select}
										/>
									) : null}
								</TableCell>
							) : null}
							{columns.map((column, index) => {
								const cell = row.cells[index]
								const edit = row.edit && !column.read_only ? row.edit : undefined
								const open = editing?.row === row.id && editing.column === column.name
								return (
									<TableCell
										key={column.name}
										onClick={
											edit && !open
												? () => setEditing({ row: row.id, column: column.name })
												: undefined
										}
										className={cn(
											'max-w-80 truncate px-3',
											edit && 'cursor-text',
											row.edited?.has(column.name) &&
												'bg-warning/10 shadow-[inset_2px_0_0_0_var(--color-warning)]',
											open && 'overflow-visible p-0',
										)}
									>
										{open && edit ? (
											<CellEditor
												value={cell}
												nullable={column.nullable ?? false}
												onDone={value => {
													setEditing(undefined)
													if (value !== undefined && value !== cell) edit(column.name, value)
												}}
											/>
										) : (
											<CellText value={cell} />
										)}
									</TableCell>
								)
							})}
						</TableRow>
					))}
				</TableBody>
			</ShadcnTable>
		</div>
	)
}

// The hairline is an inset shadow on the th: a collapsed tr border does not travel with a sticky cell.
const headClass =
	'sticky top-0 z-10 h-auto bg-card text-label text-muted-foreground shadow-[inset_0_-1px_0_0_var(--border)]'

function CellText({ value }: { value: StudioCell | undefined }) {
	if (value === undefined) return <span className='text-muted-foreground/60 italic'>default</span>
	if (value === null) return <span className='text-muted-foreground/60'>NULL</span>
	return <span title={value.length > 40 ? value : undefined}>{value}</span>
}

/** Enter or leaving the cell keeps the text, Escape drops it; `undefined` means nothing changed. */
function CellEditor({
	value,
	nullable,
	onDone,
}: {
	value: StudioCell | undefined
	nullable: boolean
	onDone: (value: StudioCell | undefined) => void
}) {
	const [draft, setDraft] = useState(value ?? '')
	// Escape blurs too, and the blur is what closes the editor, so it needs to know the text was dropped.
	const cancelled = useRef(false)
	return (
		<div className='flex items-center gap-1'>
			<Input
				mono
				autoFocus
				aria-label='Cell value'
				value={draft}
				placeholder={value === undefined ? 'default' : value === null ? 'NULL' : undefined}
				onChange={event => setDraft(event.target.value)}
				onBlur={() => onDone(cancelled.current || draft === (value ?? '') ? undefined : draft)}
				onKeyDown={event => {
					if (event.key === 'Escape') cancelled.current = true
					if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
				}}
			/>
			{nullable ? (
				<IconButton
					icon={IconCircleOff}
					label='Set to NULL'
					// Keeps the input focused, so its blur does not close the editor before this click lands.
					onMouseDown={event => event.preventDefault()}
					onClick={() => {
						cancelled.current = true
						onDone(null)
					}}
				/>
			) : null}
		</div>
	)
}
