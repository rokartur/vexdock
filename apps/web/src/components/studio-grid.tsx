import { useRef, useState } from 'react'
import { IconArrowNarrowDown, IconArrowNarrowUp, IconCircleOff, IconKey } from '@tabler/icons-react'
import { cn } from 'cn'
import { Table, TableCell, TableHead, TableRow } from '@/components/ui/table'
import type { StudioCell } from '../lib/api'
import { Check, IconButton, Input } from './primitives'

/** A console result only knows its column names; a table's columns say the rest. */
type GridColumn = { name: string; type?: string; nullable?: boolean; primary_key?: boolean; read_only?: boolean }

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
	/** Names the row's checkbox: its key's values, or "new row 2". */
	name?: string
}

/** Studio's grid: every cell is text or NULL and a button, so a click or the keyboard opens it: an editable column edits in
 * place, a read-only one shows its whole value. Unsaved changes keep their color. */
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
	const [editing, setEditing] = useState<{ row: string; column: string; open: boolean }>()
	const selectable = rows.some(row => row.select)

	return (
		<div className='min-h-0 flex-1 scroll-pt-12 overflow-auto'>
			<Table className='w-max min-w-full font-mono text-xs'>
				<thead>
					<TableRow static>
						{selectable ? (
							<TableHead className={cn(headClass, 'w-8 px-2')}>
								<span className='sr-only'>Select</span>
							</TableHead>
						) : null}
						{columns.map(column => {
							const order = sort?.column === column.name ? sort.order : undefined
							const label = (
								<span className='flex flex-col items-start py-1 text-left'>
									<span className='flex items-center gap-1 font-sans text-sm font-medium text-foreground'>
										{column.primary_key ? (
											<IconKey
												stroke={1.75}
												role='img'
												aria-label='Primary key'
												className='size-3 text-muted'
											/>
										) : null}
										{column.name}
										{order === 'asc' ? (
											<IconArrowNarrowUp stroke={1.75} className='size-3' />
										) : null}
										{order === 'desc' ? (
											<IconArrowNarrowDown stroke={1.75} className='size-3' />
										) : null}
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
									aria-sort={order ? ariaSort[order] : undefined}
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
				</thead>
				<tbody>
					{rows.map(({ select, ...row }) => (
						<TableRow
							key={row.id}
							className={cn(
								// Each cell paints the tint through --cell-base (ui/table.tsx), so hover mixes in and fades.
								row.change === 'insert' &&
									'[--cell-base:color-mix(in_oklab,var(--success)_10%,transparent)]',
								row.change === 'delete' &&
									'text-muted line-through [--cell-base:color-mix(in_oklab,var(--danger)_10%,transparent)]',
							)}
						>
							{selectable ? (
								<TableCell className='w-8 px-2'>
									{select ? (
										<Check
											label=''
											name={`Select ${row.name ?? 'row'}`}
											checked={row.selected ?? false}
											onChange={select}
										/>
									) : null}
								</TableCell>
							) : null}
							{columns.map((column, index) => {
								const cell = row.cells[index]
								const edit = row.edit && !column.read_only ? row.edit : undefined
								const current = editing?.row === row.id && editing.column === column.name
								const open = current && editing.open
								return (
									<TableCell
										key={column.name}
										className={cn(
											'max-w-80 px-0',
											index === 0 &&
												row.change === 'insert' &&
												'shadow-[inset_2px_0_0_0_var(--color-success)]',
											row.edited?.has(column.name) &&
												'shadow-[inset_2px_0_0_0_var(--color-warning)] [--cell-base:color-mix(in_oklab,var(--warning)_10%,transparent)]',
										)}
									>
										{open ? (
											<CellEditor
												column={column.name}
												value={cell}
												nullable={column.nullable ?? false}
												readOnly={!edit}
												onDone={(value, byKey) => {
													// Closed by a key, focus returns to the cell; closed by a click, it stays where the click put it.
													setEditing(
														byKey
															? { row: row.id, column: column.name, open: false }
															: undefined,
													)
													if (edit && value !== undefined && value !== cell)
														edit(column.name, value)
												}}
											/>
										) : (
											<button
												type='button'
												autoFocus={current}
												onClick={() =>
													setEditing({ row: row.id, column: column.name, open: true })
												}
												className={cn(
													'block h-10 w-full max-w-80 truncate px-3 text-left pointer-coarse:h-11',
													edit && 'cursor-text',
												)}
											>
												{index === 0 && row.change === 'insert' ? (
													<span className='mr-2 text-xs font-medium text-success'>
														New<span className='sr-only'> row: </span>
													</span>
												) : null}
												{index === 0 && row.change === 'delete' ? (
													<span className='sr-only'>Deleted row: </span>
												) : null}
												{row.edited?.has(column.name) ? (
													<span className='mr-2 text-xs font-medium text-warning'>
														Edited<span className='sr-only'>: </span>
													</span>
												) : null}
												<CellText value={cell} />
											</button>
										)}
									</TableCell>
								)
							})}
						</TableRow>
					))}
				</tbody>
			</Table>
		</div>
	)
}

const ariaSort = { asc: 'ascending', desc: 'descending' } as const

// The hairline is an inset shadow on the th: a collapsed tr border does not travel with a sticky cell.
const headClass =
	'sticky top-0 z-10 h-auto border-b-0 bg-surface text-xs text-muted shadow-[inset_0_-1px_0_0_var(--border)]'

function CellText({ value }: { value: StudioCell | undefined }) {
	if (value === undefined) return <span className='text-muted italic'>default</span>
	if (value === null) return <span className='text-muted'>NULL</span>
	// Without a mark the cell's button would have no text at all, and no name.
	if (value === '')
		return (
			<span className='text-muted'>
				<span aria-hidden>&quot;&quot;</span>
				<span className='sr-only'>empty string</span>
			</span>
		)
	return <span title={value.length > 40 ? value : undefined}>{value}</span>
}

function placeholderFor(value: StudioCell | undefined) {
	if (value === undefined) return 'default'
	return value === null ? 'NULL' : undefined
}

/** Enter or leaving the cell keeps the text, Escape drops it; `undefined` means nothing changed, `byKey` that a key
 * closed it. A read-only cell opens the same input so its whole value can be read and copied. */
function CellEditor({
	column,
	value,
	nullable,
	readOnly,
	onDone,
}: {
	column: string
	value: StudioCell | undefined
	nullable: boolean
	readOnly: boolean
	onDone: (value: StudioCell | undefined, byKey: boolean) => void
}) {
	// The draft starts as the cell itself, so a NULL or default cell typed down to nothing still saves the empty string.
	const [draft, setDraft] = useState(value)
	// Enter and Escape blur too, and the blur is what closes the editor, so it needs to know which one it was.
	const cancelled = useRef(false)
	const byKey = useRef(false)
	return (
		<div
			className='flex items-center gap-1'
			onBlur={event => {
				if (event.currentTarget.contains(event.relatedTarget)) return
				onDone(cancelled.current || draft === value ? undefined : draft, byKey.current)
			}}
			// Here, not on the input, so Escape also cancels from Set to NULL instead of a Tab out saving the draft.
			onKeyDown={event => {
				if (event.key !== 'Escape' || !(event.target instanceof HTMLElement)) return
				event.preventDefault()
				cancelled.current = true
				byKey.current = true
				event.target.blur()
			}}
		>
			<Input
				mono
				autoFocus
				readOnly={readOnly}
				aria-label={`${column} value`}
				value={draft ?? ''}
				placeholder={placeholderFor(value)}
				onChange={event => setDraft(event.target.value)}
				onKeyDown={event => {
					if (event.key !== 'Enter') return
					// Focus is back on the cell's button before Enter's keypress, which would click it open again.
					event.preventDefault()
					byKey.current = true
					event.currentTarget.blur()
				}}
			/>
			{nullable && !readOnly ? (
				<IconButton
					icon={IconCircleOff}
					label='Set to NULL'
					// Safari does not focus a clicked button, so the input's blur would close the editor before this click lands.
					onMouseDown={event => event.preventDefault()}
					onClick={() => {
						cancelled.current = true
						byKey.current = true
						onDone(null, true)
					}}
				/>
			) : null}
		</div>
	)
}
