import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Button, ErrorText, Fact, Facts, Page, Refresh, Section } from '../components/primitives'
import { type AnalyticsRange, api, type Breakdown, type TrafficPoint } from '../lib/api'

const ranges: { value: AnalyticsRange; label: string }[] = [
	{ value: '24h', label: '24 hours' },
	{ value: '7d', label: '7 days' },
	{ value: '30d', label: '30 days' },
]

export const Route = createFileRoute('/analytics')({ component: AnalyticsPage })

function AnalyticsPage() {
	const [hostname, setHostname] = useState<string | null>(null)
	const [range, setRange] = useState<AnalyticsRange>('24h')

	const domains = useQuery({ queryKey: ['domains'], queryFn: api.domains })
	const tracked = domains.data?.filter(domain => domain.analytics) ?? []
	const selected = tracked.find(domain => domain.hostname === hostname)?.hostname ?? tracked[0]?.hostname

	const analytics = useQuery({
		queryKey: ['analytics', selected, range],
		queryFn: () => api.analytics(selected as string, range),
		enabled: Boolean(selected),
		// Online counts age out after five minutes, so keep them close to live.
		refetchInterval: 30_000,
	})
	const traffic = analytics.data?.traffic
	const queryClient = useQueryClient()
	const [confirmClear, setConfirmClear] = useState(false)
	const clear = useMutation({
		mutationFn: () => api.clearAnalytics(selected as string),
		onSuccess: () => {
			setConfirmClear(false)
			return queryClient.invalidateQueries({ queryKey: ['analytics'] })
		},
	})

	if (!(domains.isLoading || tracked.length)) {
		return (
			<Page>
				<Section title='Analytics' description='no domain is collecting yet'>
					<p className='text-body text-muted-foreground'>
						Turn on Analytics for a domain in its project to start counting visits. Nothing has to change
						inside the deployed app.
					</p>
				</Section>
			</Page>
		)
	}

	return (
		<Page
			actions={<Refresh onClick={() => analytics.refetch()} busy={analytics.isFetching} />}
			toolbar={
				<div className='flex w-full items-end justify-between gap-4 pb-2'>
					<select
						value={selected ?? ''}
						onChange={event => setHostname(event.target.value)}
						className='h-7 rounded-sm border bg-transparent px-2 text-body'
					>
						{tracked.map(domain => (
							<option key={domain.id} value={domain.hostname}>
								{domain.hostname}
							</option>
						))}
					</select>
					<div className='flex gap-1'>
						{ranges.map(option => (
							<Button
								key={option.value}
								variant={option.value === range ? 'default' : 'ghost'}
								onClick={() => setRange(option.value)}
							>
								{option.label}
							</Button>
						))}
					</div>
				</div>
			}
		>
			<ErrorText error={analytics.error} />

			<Section title='Traffic' description={selected}>
				<Facts>
					<Fact label='Online now' value={traffic?.online ?? '-'} />
					<Fact label='Unique visitors' value={traffic?.visitors ?? '-'} />
					<Fact label='Page views' value={traffic?.views ?? '-'} />
					<Fact label='Visits' value={traffic?.visits ?? '-'} />
					<Fact label='Avg visit' value={traffic ? duration(traffic.avg_duration) : '-'} />
					<Fact label='Bounce rate' value={traffic ? `${Math.round(traffic.bounce_rate * 100)}%` : '-'} />
				</Facts>
				<Bars points={traffic?.series ?? []} />
			</Section>

			<div className='grid grid-cols-1 gap-x-8 md:grid-cols-2'>
				<Top title='Top pages' rows={traffic?.pages} unit='views' />
				<Top title='Currently reading' rows={traffic?.online_pages} unit='visitors' />
				<Top title='Referrers' rows={traffic?.referrers} unit='visitors' />
				<Top title='Countries and regions' rows={traffic?.countries} unit='visitors' />
				<Top title='Devices' rows={traffic?.devices} unit='visitors' />
				<Top title='Browsers' rows={traffic?.browsers} unit='visitors' />
				<Top title='Operating systems' rows={traffic?.systems} unit='visitors' />
				<Top title='Events' rows={traffic?.events} unit='fired' />
			</div>

			<Section title='Clear statistics' description='every event of this site, all ranges'>
				<ErrorText error={clear.error} />
				{confirmClear ? (
					<div className='flex gap-2'>
						<Button variant='danger' onClick={() => clear.mutate()} disabled={clear.isPending}>
							{clear.isPending ? 'Deleting…' : `Delete every event of ${selected}`}
						</Button>
						<Button variant='ghost' onClick={() => setConfirmClear(false)}>
							Cancel
						</Button>
					</div>
				) : (
					<Button variant='danger' onClick={() => setConfirmClear(true)}>
						Clear statistics
					</Button>
				)}
				<p className='mt-1 text-label text-muted-foreground'>
					The counters restart from zero and the history is gone. There is no undo and no export, and the
					other tracked domains are untouched. Collection stays on.
				</p>
			</Section>
		</Page>
	)
}

/** Page views per bucket. A bar chart of divs beats a charting dependency. */
function Bars({ points }: { points: TrafficPoint[] }) {
	const peak = Math.max(1, ...points.map(point => point.views))
	if (!points.length) return <p className='text-body text-muted-foreground'>No visits in this window.</p>
	return (
		<div className='flex h-28 items-end gap-px'>
			{points.map(point => (
				<div
					key={point.at}
					title={`${new Date(point.at * 1000).toLocaleString()} · ${point.views} views · ${point.visitors} visitors`}
					style={{ height: `${Math.max(2, (point.views / peak) * 100)}%` }}
					className='min-w-px flex-1 bg-foreground/60 hover:bg-foreground'
				/>
			))}
		</div>
	)
}

function Top({ title, rows, unit }: { title: string; rows: Breakdown[] | undefined; unit: string }) {
	const value = (row: Breakdown) => (unit === 'views' || unit === 'fired' ? row.count : row.visitors)
	const peak = Math.max(1, ...(rows ?? []).map(value))
	return (
		<Section title={title} description={unit}>
			{rows?.length ? (
				<ul>
					{rows.map(row => (
						<li key={row.name} className='relative flex justify-between gap-4 px-1 py-1 text-body'>
							{/* The share bar sits behind the row instead of taking a column. */}
							<span
								aria-hidden
								style={{ width: `${(value(row) / peak) * 100}%` }}
								className='absolute inset-y-0 left-0 bg-foreground/8'
							/>
							<span className='relative truncate'>{row.name}</span>
							<span className='relative font-mono tabular-nums'>{value(row)}</span>
						</li>
					))}
				</ul>
			) : (
				<p className='text-body text-muted-foreground'>Nothing yet.</p>
			)}
		</Section>
	)
}

function duration(seconds: number) {
	const minutes = Math.floor(seconds / 60)
	return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}
