import { useState } from 'react'
import {
	IconChevronLeft,
	IconChevronRight,
	IconFilter,
	IconPlus,
	IconTable,
	IconTrash,
	IconX,
} from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useBlocker, useNavigate } from '@tanstack/react-router'
import {
	Button,
	Confirm,
	ConfirmLeave,
	EmptyState,
	ErrorText,
	IconButton,
	Input,
	Refresh,
	Select,
} from '../components/primitives'
import { type GridRow, StudioGrid } from '../components/studio-grid'
import {
	api,
	type StudioCell,
	type StudioColumn,
	type StudioFilter,
	type StudioFilterOp,
	type StudioRows,
	type StudioRowsQuery,
	type StudioValues,
} from '../lib/api'
import { useStudio } from './projects.$projectId_.services.$serviceId.studio'

type GridSearch = { page?: number; sort?: string; order?: 'asc' | 'desc'; where?: StudioFilter[] }

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/studio/')({
	// The URL is typed by hand as often as it is followed; the manager rejects a filter that names nothing real.
	validateSearch: (search: Record<string, unknown>) => {
		const result: GridSearch = {}
		if (typeof search.page === 'number' && Number.isInteger(search.page) && search.page > 1)
			result.page = search.page
		if (typeof search.sort === 'string') result.sort = search.sort
		if (search.order === 'asc' || search.order === 'desc') result.order = search.order
		if (Array.isArray(search.where) && search.where.every(isFilter)) result.where = search.where
		return result
	},
	component: StudioTable,
})

const pageSize = 50

const operators: { value: StudioFilterOp; label: string }[] = [
	{ value: 'eq', label: '=' },
	{ value: 'neq', label: '<>' },
	{ value: 'gt', label: '>' },
	{ value: 'gte', label: '>=' },
	{ value: 'lt', label: '<' },
	{ value: 'lte', label: '<=' },
	{ value: 'contains', label: 'contains' },
	{ value: 'starts_with', label: 'starts with' },
	{ value: 'is_null', label: 'is null' },
	{ value: 'is_not_null', label: 'is not null' },
]

function isFilter(value: unknown): value is StudioFilter {
	return (
		typeof value === 'object' &&
		value !== null &&
		'column' in value &&
		typeof value.column === 'string' &&
		'value' in value &&
		typeof value.value === 'string' &&
		'op' in value &&
		operators.some(operator => operator.value === value.op)
	)
}

function StudioTable() {
	const { schema, table } = useStudio()
	if (!schema) return null
	if (!table) return <EmptyState icon={IconTable} title={`${schema.name} has no tables.`} />
	// Keyed so unsaved changes and the selection never follow the reader to another table.
	return (
		<TableView
			key={`${schema.name}/${table.name}`}
			schema={schema.name}
			table={table.name}
			view={table.view}
			columns={table.columns}
		/>
	)
}

type Key = Record<string, string>

function TableView({
	schema,
	table,
	view,
	columns: schemaColumns,
}: {
	schema: string
	table: string
	view: boolean
	columns: StudioColumn[]
}) {
	const { serviceId } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const queryClient = useQueryClient()
	const page = search.page ?? 1
	const query: StudioRowsQuery = {
		schema,
		table,
		limit: pageSize,
		offset: (page - 1) * pageSize,
		sort: search.sort,
		order: search.order,
		where: search.where,
	}
	const rows = useQuery({
		queryKey: ['studio', serviceId, 'rows', query],
		queryFn: () => api.studioRows(serviceId, query),
		placeholderData: keepPreviousData,
	})

	const [updates, setUpdates] = useState<Record<string, { key: Key; values: StudioValues }>>({})
	const [inserts, setInserts] = useState<StudioValues[]>([])
	const [deletes, setDeletes] = useState<Record<string, Key>>({})
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
	const [filtering, setFiltering] = useState(false)

	const discard = () => {
		setUpdates({})
		setInserts([])
		setDeletes({})
		setSelected(new Set())
		save.reset()
	}
	const save = useMutation({
		mutationFn: () =>
			api.studioChanges(serviceId, {
				schema,
				table,
				updates: Object.values(updates),
				inserts,
				deletes: Object.values(deletes).map(key => ({ key })),
			}),
		onSuccess: async () => {
			discard()
			await queryClient.invalidateQueries({ queryKey: ['studio', serviceId] })
		},
	})

	const counts = { edits: Object.keys(updates).length, inserts: inserts.length, deletes: Object.keys(deletes).length }
	const pending = counts.edits + counts.inserts + counts.deletes
	const leaving = useBlocker({
		// Paging, sorting and filtering keep the edits, which are held by key; anything else drops them.
		shouldBlockFn: ({ current, next }) => place(next) !== place(current),
		withResolver: true,
		enableBeforeUnload: pending > 0,
		disabled: pending === 0,
	})

	const { data } = rows
	// A collection with no documents lists no fields, but a new one still needs its key.
	const columns =
		data && data.columns.length > 0
			? data.columns
			: schemaColumns.length > 0
				? schemaColumns
				: (data?.key ?? []).map(name => keyColumn(name))
	const readOnly = view
		? 'Views are read-only.'
		: data?.key.length === 0
			? 'No primary key, so rows cannot be told apart.'
			: undefined
	const editable = data !== undefined && readOnly === undefined

	const keys: Record<string, Key> = {}
	const gridRows: GridRow[] = inserts.map((values, index) => {
		const id = `new:${index}`
		return {
			id,
			cells: columns.map(column => values[column.name]),
			change: 'insert',
			edit: (column, value) =>
				setInserts(previous => previous.with(index, { ...previous[index], [column]: value })),
			selected: selected.has(id),
			select: on => setSelected(toggle(selected, id, on)),
		}
	})
	for (const [index, cells] of (data?.rows ?? []).entries()) {
		const key = data && editable ? keyOf(data, cells) : undefined
		if (!key) {
			gridRows.push({ id: `row:${index}`, cells })
			continue
		}
		const id = JSON.stringify(key)
		keys[id] = key
		const update = updates[id]
		if (id in deletes) {
			gridRows.push({ id, cells, change: 'delete' })
			continue
		}
		gridRows.push({
			id,
			cells: columns.map((column, i) => {
				const edited = update?.values[column.name]
				return edited === undefined ? cells[i] : edited
			}),
			edited: new Set(Object.keys(update?.values ?? {})),
			edit: (column, value) =>
				setUpdates(previous => ({
					...previous,
					[id]: { key, values: { ...previous[id]?.values, [column]: value } },
				})),
			selected: selected.has(id),
			select: on => setSelected(toggle(selected, id, on)),
		})
	}

	const deleteSelected = () => {
		setDeletes(previous => {
			const next = { ...previous }
			for (const id of selected) {
				const key = keys[id]
				if (key) next[id] = key
			}
			return next
		})
		// A row both edited and deleted is only deleted.
		setUpdates(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !selected.has(id))))
		setInserts(previous => previous.filter((_, index) => !selected.has(`new:${index}`)))
		setSelected(new Set())
	}

	const where = search.where ?? []
	const setWhere = (next: StudioFilter[]) =>
		navigate({
			search: previous => ({ ...previous, where: next.length > 0 ? next : undefined, page: undefined }),
		})
	const offset = (page - 1) * pageSize
	const last = data !== undefined && offset + pageSize >= data.total && !data.truncated

	return (
		<>
			<ConfirmLeave blocker={leaving} />
			<div className='flex h-11 shrink-0 items-center gap-2 border-b px-2'>
				<IconButton
					icon={IconFilter}
					label='Filter'
					aria-pressed={filtering}
					disabled={columns.length === 0}
					onClick={() => setFiltering(!filtering)}
				/>
				{where.map((filter, index) => (
					<span
						key={`${filter.column}-${filter.op}-${filter.value}`}
						className='flex h-7 items-center gap-1 rounded-md border pl-2 font-mono text-label'
					>
						{filter.column} {operators.find(operator => operator.value === filter.op)?.label} {filter.value}
						<IconButton
							icon={IconX}
							label='Remove filter'
							onClick={() => setWhere(where.toSpliced(index, 1))}
						/>
					</span>
				))}
				<div className='ml-auto flex items-center gap-2'>
					{readOnly ? <span className='text-label text-muted-foreground'>{readOnly}</span> : null}
					{selected.size > 0 ? (
						<Button variant='danger' onClick={deleteSelected}>
							<IconTrash />
							Delete {selected.size}
						</Button>
					) : null}
					<Button disabled={!editable} onClick={() => setInserts([...inserts, {}])}>
						<IconPlus />
						Add row
					</Button>
					<Refresh onClick={() => rows.refetch()} busy={rows.isFetching} />
					<span className='text-label text-muted-foreground tabular-nums'>
						{data ? pagerText(offset, data) : null}
					</span>
					<IconButton
						icon={IconChevronLeft}
						label='Previous page'
						disabled={page <= 1}
						onClick={() =>
							navigate({
								search: previous => ({ ...previous, page: page > 2 ? page - 1 : undefined }),
							})
						}
					/>
					<IconButton
						icon={IconChevronRight}
						label='Next page'
						disabled={data === undefined || last}
						onClick={() => navigate({ search: previous => ({ ...previous, page: page + 1 }) })}
					/>
				</div>
			</div>
			{filtering && columns.length > 0 ? (
				<FilterForm columns={columns} onAdd={filter => setWhere([...where, filter])} />
			) : null}
			{rows.error ? (
				<div className='p-3'>
					<ErrorText error={rows.error} />
				</div>
			) : null}
			{data ? (
				<StudioGrid
					columns={columns}
					rows={gridRows}
					sort={{ column: search.sort, order: search.order }}
					onSort={column =>
						navigate({
							search: previous => ({ ...previous, ...nextSort(search, column), page: undefined }),
						})
					}
				/>
			) : null}
			{data && gridRows.length === 0 ? (
				<EmptyState title={where.length > 0 ? 'No rows match these filters.' : 'This table is empty.'} />
			) : null}
			{pending > 0 || save.error ? (
				<div className='shrink-0 border-t px-3 py-2'>
					<ErrorText error={save.error} />
					<div className='flex items-center gap-2'>
						<span className='text-body text-muted-foreground tabular-nums'>{pendingText(counts)}</span>
						<div className='ml-auto flex gap-2'>
							<Button variant='ghost' onClick={discard} disabled={save.isPending}>
								Discard
							</Button>
							{counts.deletes > 0 ? (
								<Confirm
									title={`Delete ${counts.deletes} ${counts.deletes === 1 ? 'row' : 'rows'} from ${table}?`}
									description='The deletes are saved with the other changes, in one transaction.'
									action='Save'
									onConfirm={() => save.mutate()}
								>
									<Button variant='primary' disabled={save.isPending}>
										Save {pending} {pending === 1 ? 'change' : 'changes'}
									</Button>
								</Confirm>
							) : (
								<Button
									variant='primary'
									onClick={() => save.mutate()}
									disabled={save.isPending || pending === 0}
								>
									Save {pending} {pending === 1 ? 'change' : 'changes'}
								</Button>
							)}
						</div>
					</div>
				</div>
			) : null}
		</>
	)
}

function FilterForm({ columns, onAdd }: { columns: StudioColumn[]; onAdd: (filter: StudioFilter) => void }) {
	const [column, setColumn] = useState(columns[0]?.name ?? '')
	const [op, setOp] = useState<StudioFilterOp>('eq')
	const [value, setValue] = useState('')
	const needsValue = op !== 'is_null' && op !== 'is_not_null'
	return (
		<form
			className='flex shrink-0 items-center gap-2 border-b px-2 py-2'
			onSubmit={event => {
				event.preventDefault()
				onAdd({ column, op, value: needsValue ? value : '' })
				setValue('')
			}}
		>
			<Select
				label='Column'
				className='w-48'
				value={column}
				options={columns.map(c => ({ value: c.name, label: c.name }))}
				onChange={setColumn}
			/>
			<Select label='Operator' className='w-36' value={op} options={operators} onChange={setOp} />
			{needsValue ? (
				<Input
					mono
					aria-label='Value'
					placeholder='Value'
					value={value}
					onChange={event => setValue(event.target.value)}
				/>
			) : null}
			<Button type='submit'>Add filter</Button>
		</form>
	)
}

/** The table a location shows. The blocker's locations are typed for every route in the app, hence the `in`. */
const place = ({ routeId, search }: { routeId: string; search: object }) =>
	JSON.stringify([routeId, 'schema' in search && search.schema, 'table' in search && search.table])

/** The key that tells this row apart, or nothing when a key column is NULL and the row cannot be addressed. */
function keyOf(data: StudioRows, cells: StudioCell[]) {
	const key: Key = {}
	for (const name of data.key) {
		const cell = cells[data.columns.findIndex(column => column.name === name)]
		if (cell === null || cell === undefined) return
		key[name] = cell
	}
	return key
}

const keyColumn = (name: string): StudioColumn => ({
	name,
	type: '',
	nullable: false,
	primary_key: true,
	read_only: false,
})

function toggle(set: ReadonlySet<string>, id: string, on: boolean) {
	const next = new Set(set)
	if (on) next.add(id)
	else next.delete(id)
	return next
}

/** A header click walks ascending, descending, then back to the table's own order. */
function nextSort(search: GridSearch, column: string): Pick<GridSearch, 'sort' | 'order'> {
	if (search.sort !== column) return { sort: column, order: 'asc' }
	if (search.order === 'asc') return { sort: column, order: 'desc' }
	return { sort: undefined, order: undefined }
}

const count = (value: number) => value.toLocaleString('en-US')

function pagerText(offset: number, data: StudioRows) {
	if (data.rows.length === 0) return `0 of ${count(data.total)}`
	return `${count(offset + 1)}–${count(offset + data.rows.length)} of ${count(data.total)}${data.truncated ? '+' : ''}`
}

function pendingText(counts: { edits: number; inserts: number; deletes: number }) {
	const parts = []
	if (counts.edits > 0) parts.push(`${counts.edits} ${counts.edits === 1 ? 'edit' : 'edits'}`)
	if (counts.inserts > 0) parts.push(`${counts.inserts} new`)
	if (counts.deletes > 0) parts.push(`${counts.deletes} ${counts.deletes === 1 ? 'delete' : 'deletes'}`)
	return parts.join(' · ')
}
