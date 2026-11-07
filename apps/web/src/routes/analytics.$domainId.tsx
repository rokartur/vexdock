import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Outlet, retainSearchParams, useNavigate, useRouterState } from '@tanstack/react-router'
import { FilterChips } from '../components/analytics-report'
import { Check, Input, Page, PendingReading, Segmented, Select, Tabs } from '../components/primitives'
import type { AnalyticsRange, AnalyticsSpan } from '../lib/api'
import { analyticsSitesQuery, preload } from '../lib/queries'

type SiteSearch = {
	range?: AnalyticsRange
	from?: string
	to?: string
	filters?: [string, string][]
	compare?: boolean
}

const ranges = [
	{ value: 'today', label: 'Today' },
	{ value: 'yesterday', label: 'Yesterday' },
	{ value: '24h', label: '24h' },
	{ value: '7d', label: '7d' },
	{ value: '30d', label: '30d' },
	{ value: '90d', label: '90d' },
	{ value: '12m', label: '12m' },
	{ value: 'all', label: 'All' },
] as const satisfies readonly { value: AnalyticsRange; label: string }[]

const rangeOptions = [...ranges, { value: 'custom', label: 'Custom' }] as const

const day = /^\d{4}-\d{2}-\d{2}$/u

function isFilter(value: unknown): value is [string, string] {
	return Array.isArray(value) && value.length === 2 && value.every(part => typeof part === 'string')
}

// The span lives in the URL, so a pasted link opens the same report and every tab reads the same one.
function validateSearch(search: Record<string, unknown>): SiteSearch {
	const out: SiteSearch = {}
	const range = ranges.find(option => option.value === search.range)
	if (range) out.range = range.value
	if (typeof search.from === 'string' && day.test(search.from)) out.from = search.from
	if (typeof search.to === 'string' && day.test(search.to)) out.to = search.to
	if (Array.isArray(search.filters)) out.filters = search.filters.filter(isFilter)
	if (search.compare === true) out.compare = true
	return out
}

export const Route = createFileRoute('/analytics/$domainId')({
	validateSearch,
	search: { middlewares: [retainSearchParams<SiteSearch>(['range', 'from', 'to', 'filters', 'compare'])] },
	loader: ({ context: { queryClient } }) => preload(queryClient, analyticsSitesQuery),
	component: SiteLayout,
})

/** The span every tab of a site reports on, and a way to change it. */
export function useSpan() {
	const search = Route.useSearch()
	const navigate = useNavigate()
	const span: AnalyticsSpan = {
		range: search.range ?? '7d',
		from: search.from,
		to: search.to,
		filters: search.filters ?? [],
		compare: search.compare ?? false,
	}
	// A filter added from a breakdown row deep in the report keeps the reader where they clicked.
	const update = (patch: SiteSearch) =>
		navigate({
			to: '.',
			search: (previous: SiteSearch) => ({ ...previous, ...patch }),
			replace: true,
			resetScroll: false,
		})
	const addFilter = (dimension: string, value: string) => {
		const kept = span.filters?.filter(([d]) => d !== dimension) ?? []
		void update({ filters: [...kept, [dimension, value]] })
	}
	return { span, update, addFilter }
}

const tabs = [
	{ suffix: '', label: 'Overview' },
	{ suffix: '/live', label: 'Live' },
	{ suffix: '/visitors', label: 'Visitors' },
	{ suffix: '/funnels', label: 'Funnels' },
	{ suffix: '/settings', label: 'Settings' },
]

function SiteLayout() {
	const { domainId } = Route.useParams()
	const sites = useQuery(analyticsSitesQuery)
	const hostname = sites.data?.find(site => site.domain.id === domainId)?.domain.hostname
	const pathname = useRouterState({ select: state => state.location.pathname })
	// Live is always the last minutes, and settings have no span.
	const spanless = pathname.endsWith('/live') || pathname.endsWith('/settings')
	// Live and Visitors end in one long table that takes the rest of the window.
	const fill = pathname.endsWith('/live') || pathname.endsWith('/visitors')

	return (
		<Page
			fill={fill}
			labels={{
				[domainId]: hostname ?? (
					<PendingReading label='site' failed={sites.data !== undefined || sites.isError} />
				),
			}}
			name={hostname}
			index='Overview'
			toolbar={<Tabs base={`/analytics/${domainId}`} tabs={tabs} />}
			// Only the overview's report reads `compare`; visitors and funnels ignore it.
			filters={spanless ? undefined : <SpanPicker compares={pathname === `/analytics/${domainId}`} />}
		>
			<Outlet />
		</Page>
	)
}

function SpanPicker({ compares }: { compares: boolean }) {
	const { span, update } = useSpan()
	const custom = Boolean(span.from && span.to)
	const today = new Date().toLocaleDateString('en-CA')
	const range = custom ? 'custom' : span.range
	const pickRange = (value: typeof range) =>
		value === 'custom'
			? update({ from: span.from ?? today, to: span.to ?? today })
			: update({ range: value, from: undefined, to: undefined })

	return (
		<div className='flex min-w-0 flex-wrap items-center gap-3'>
			{/* The nine ranges take 540px, more than a phone or a 768px window beside the open rail has. */}
			<Segmented
				label='Range'
				value={range}
				options={rangeOptions}
				onChange={pickRange}
				className='max-lg:hidden'
			/>
			<Select
				label='Range'
				value={range}
				options={rangeOptions}
				onChange={pickRange}
				className='w-auto lg:hidden'
			/>
			{custom ? (
				<>
					<Input
						aria-label='From'
						type='date'
						max={span.to}
						value={span.from}
						onChange={event => event.target.value && update({ from: event.target.value })}
					/>
					<Input
						aria-label='To'
						type='date'
						min={span.from}
						max={today}
						value={span.to}
						onChange={event => event.target.value && update({ to: event.target.value })}
					/>
				</>
			) : null}
			{compares ? (
				<Check
					label='Compare with the previous period'
					checked={span.compare ?? false}
					onChange={checked => update({ compare: checked || undefined })}
				/>
			) : null}
			<FilterChips
				filters={span.filters ?? []}
				onRemove={index => update({ filters: span.filters?.filter((_, i) => i !== index) })}
			/>
		</div>
	)
}
