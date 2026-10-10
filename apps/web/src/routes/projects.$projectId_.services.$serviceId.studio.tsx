import { useState } from 'react'
import { IconDatabaseOff, IconEye, IconPlayerPlay, IconRocket, IconTable, IconTerminal } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { cn } from '@/utils/cn'
import { ActivePill, Button, EmptyState, ErrorText, Input, Select } from '../components/primitives'
import { api } from '../lib/api'
import { useService } from './projects.$projectId_.services.$serviceId'

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
	if (service.data.state !== 'running') return <NotRunning serviceId={serviceId} />
	return <StudioPane />
}

function NotRunning({ serviceId }: { serviceId: string }) {
	const queryClient = useQueryClient()
	const onSuccess = () => queryClient.invalidateQueries({ queryKey: ['service', serviceId] })
	const start = useMutation({ mutationFn: () => api.serviceAction(serviceId, 'start'), onSuccess })
	const deploy = useMutation({ mutationFn: () => api.deployService(serviceId), onSuccess })
	const busy = start.isPending || deploy.isPending
	return (
		<div className='rounded-xl border bg-card raised'>
			<EmptyState
				icon={IconDatabaseOff}
				title='The database is not running.'
				description='Studio talks to the running container. Start it, or deploy it if it never ran.'
			>
				<ErrorText error={start.error ?? deploy.error} />
				<div className='flex gap-2'>
					<Button onClick={() => start.mutate()} disabled={busy}>
						<IconPlayerPlay />
						Start
					</Button>
					<Button variant='primary' onClick={() => deploy.mutate()} disabled={busy}>
						<IconRocket />
						Deploy
					</Button>
				</div>
			</EmptyState>
		</div>
	)
}

function StudioPane() {
	const { projectId, serviceId } = Route.useParams()
	const navigate = useNavigate()
	const matchRoute = useMatchRoute()
	const { schemas, schema, tables, table } = useStudio()
	const [filter, setFilter] = useState('')

	if (schemas.error) return <ErrorText error={schemas.error} />
	if (!schemas.data) return null
	if (!schema) return <EmptyState icon={IconDatabaseOff} title='This database has no schemas.' />

	const params = { projectId, serviceId }
	const onConsole = Boolean(matchRoute({ to: '/projects/$projectId/services/$serviceId/studio/console' }))
	const needle = filter.trim().toLowerCase()

	return (
		<div className='flex min-h-96 flex-1 overflow-hidden rounded-xl border bg-card'>
			<aside className='flex w-60 shrink-0 flex-col gap-2 border-r p-2'>
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
				<Input
					type='search'
					aria-label='Search tables'
					placeholder='Search tables'
					value={filter}
					onChange={event => setFilter(event.target.value)}
				/>
				<nav className='-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto px-2'>
					<Link
						to='/projects/$projectId/services/$serviceId/studio/console'
						params={params}
						search={{ schema: schema.name }}
						className={cn(entryClass, onConsole && activeClass)}
					>
						{onConsole ? <ActivePill layoutId='studio' className='bg-muted' /> : null}
						<IconTerminal className='size-4 shrink-0' />
						Console
					</Link>
					{tables
						.filter(t => t.name.toLowerCase().includes(needle))
						.map(t => {
							const active = !onConsole && table?.name === t.name
							return (
								<Link
									key={t.name}
									to='/projects/$projectId/services/$serviceId/studio'
									params={params}
									search={{ schema: schema.name, table: t.name }}
									className={cn(entryClass, active && activeClass)}
								>
									{active ? <ActivePill layoutId='studio' className='bg-muted' /> : null}
									{t.view ? (
										<IconEye aria-label='View' className='size-4 shrink-0' />
									) : (
										<IconTable className='size-4 shrink-0' />
									)}
									<span className='truncate'>{t.name}</span>
								</Link>
							)
						})}
				</nav>
			</aside>
			<div className='flex min-w-0 flex-1 flex-col'>
				<Outlet />
			</div>
		</div>
	)
}

const entryClass =
	'relative isolate flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-body text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
const activeClass = 'text-foreground'
