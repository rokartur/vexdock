import { useState } from 'react'
import { IconDatabaseOff, IconEye, IconTable, IconTerminal, IconTerminal2 } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { cn } from 'cn'
import { ActivePill, Button, EmptyState, ErrorText, Select } from '../components/primitives'
import { SearchField } from '../components/ui/search-field'
import { Skeleton } from '../components/ui/skeleton'
import { api } from '../lib/api'
import { NotRunning, useService } from './projects.$projectId_.services.$serviceId'

type StudioSearch = { schema?: string; table?: string }

export const Route = createFileRoute('/projects/$projectId_/services/$serviceId/studio')({
	validateSearch: (search: Record<string, unknown>) => {
		const result: StudioSearch = {}
		if (typeof search.schema === 'string') result.schema = search.schema
		if (typeof search.table === 'string') result.table = search.table
		return result
	},
	component: Studio,
})

/** The schema and table the URL names, else what Drizzle opens: `public`, then the first table in it. */
export function useStudio() {
	const { serviceId } = Route.useParams()
	const search = Route.useSearch()
	const schemas = useQuery({ queryKey: ['studio', serviceId, 'schema'], queryFn: () => api.studioSchema(serviceId) })
	const list = schemas.data?.schemas ?? []
	const schema =
		list.find(s => s.name === search.schema) ??
		list.find(s => s.name === 'public') ??
		list.find(s => s.tables.length > 0) ??
		list[0]
	// Tables first, then views; the sidebar's icon tells them apart.
	const tables = schema?.tables.toSorted((a, b) => Number(a.view) - Number(b.view)) ?? []
	const table = tables.find(t => t.name === search.table) ?? tables[0]
	return { serviceId, schemas, schema, tables, table }
}

function Studio() {
	const { serviceId } = Route.useParams()
	const service = useService(serviceId)
	if (!service.data) return null
	if (service.data.state !== 'running') {
		return (
			<NotRunning
				service={service.data}
				title='The database is not running'
				description='Studio talks to the running container.'
			/>
		)
	}
	return <StudioPane />
}

function StudioPane() {
	const { projectId, serviceId } = Route.useParams()
	const navigate = useNavigate()
	const matchRoute = useMatchRoute()
	const { schemas, schema, tables, table } = useStudio()
	const [filter, setFilter] = useState('')

	if (schemas.error) return <ErrorText error={schemas.error} />
	if (!schemas.data) {
		return (
			<div className='flex min-h-96 flex-1 flex-col rounded-surface border bg-surface p-5'>
				<Skeleton label='Loading the schema' lines={4} />
			</div>
		)
	}
	if (!schema) {
		return (
			<div className='rounded-surface border bg-surface'>
				<EmptyState
					heading='h2'
					icon={IconDatabaseOff}
					title='This database has no schemas'
					description="The Terminal tab opens a shell in the container, where the engine's client creates one."
				>
					<Button
						render={
							<Link
								to='/projects/$projectId/services/$serviceId/terminal'
								params={{ projectId, serviceId }}
							/>
						}
					>
						<IconTerminal2 size={16} stroke={1.75} />
						Open terminal
					</Button>
				</EmptyState>
			</div>
		)
	}

	const params = { projectId, serviceId }
	const onConsole = Boolean(matchRoute({ to: '/projects/$projectId/services/$serviceId/studio/console' }))
	const needle = filter.trim().toLowerCase()
	const listed = tables.filter(t => t.name.toLowerCase().includes(needle))

	return (
		<div className='flex min-h-96 flex-1 flex-col overflow-hidden rounded-surface border bg-surface sm:flex-row'>
			<aside className='flex max-h-48 shrink-0 flex-col gap-2 border-b p-2 sm:max-h-none sm:w-60 sm:border-r sm:border-b-0'>
				{schemas.data.schemas.length > 1 ? (
					<Select
						label='Schema'
						value={schema.name}
						options={schemas.data.schemas.map(s => ({ value: s.name, label: s.name }))}
						onChange={name =>
							navigate({
								to: '/projects/$projectId/services/$serviceId/studio',
								params,
								search: { schema: name },
							})
						}
					/>
				) : null}
				<SearchField
					label='Search tables'
					hideLabel
					placeholder='Search tables'
					value={filter}
					onValueChange={setFilter}
				/>
				<nav aria-label='Tables' className='-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto px-2'>
					<Link
						to='/projects/$projectId/services/$serviceId/studio/console'
						params={params}
						search={{ schema: schema.name }}
						aria-current={onConsole ? 'page' : undefined}
						className={cn(entryClass, onConsole && activeClass)}
					>
						{onConsole ? <ActivePill layoutId='studio' /> : null}
						<IconTerminal stroke={1.75} className='size-4 shrink-0' />
						Console
					</Link>
					{listed.map(t => {
						const active = !onConsole && table?.name === t.name
						return (
							<Link
								key={t.name}
								to='/projects/$projectId/services/$serviceId/studio'
								params={params}
								search={{ schema: schema.name, table: t.name }}
								aria-current={active ? 'page' : undefined}
								className={cn(entryClass, active && activeClass)}
							>
								{active ? <ActivePill layoutId='studio' /> : null}
								{t.view ? (
									<IconEye stroke={1.75} role='img' aria-label='View' className='size-4 shrink-0' />
								) : (
									<IconTable stroke={1.75} className='size-4 shrink-0' />
								)}
								<span className='min-w-0 wrap-anywhere'>{t.name}</span>
							</Link>
						)
					})}
					{/* Stays mounted while empty (no padding, no height) so the message lands in a live region. */}
					<p role='status' className='px-2 py-1.5 text-xs text-muted empty:py-0'>
						{needle && listed.length === 0 ? 'No tables match' : ''}
					</p>
				</nav>
			</aside>
			<div className='relative flex min-h-0 min-w-0 flex-1 flex-col'>
				<Outlet />
			</div>
		</div>
	)
}

const entryClass =
	'relative isolate flex min-h-8 shrink-0 items-center gap-2 rounded-control px-2 py-1.5 text-sm text-muted transition-colors duration-110 ease-standard hover:bg-surface-muted hover:text-foreground motion-reduce:transition-none pointer-coarse:min-h-11'
const activeClass = 'text-foreground'
