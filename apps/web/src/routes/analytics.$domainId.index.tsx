import { useState } from 'react'
import { IconBrandReddit, IconBrandX, IconNote, IconPlus, IconTrash } from '@tabler/icons-react'
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { CodeBlock } from '@/components/ui/code-block'
import { Skeleton } from '@/components/ui/skeleton'
import { Breakdowns, NoVisits, Readings, TrafficChart, annotationTitle } from '../components/analytics-report'
import {
	Button,
	Confirm,
	ErrorText,
	Field,
	FormDialog,
	IconButton,
	Input,
	RelativeTime,
} from '../components/primitives'
import { type AnalyticsSpan, type Annotation, api } from '../lib/api'
import { useSpan } from './analytics.$domainId'

const reportQuery = (domainId: string, span: AnalyticsSpan) =>
	queryOptions({
		queryKey: ['analytics', domainId, 'report', span],
		queryFn: () => api.analyticsReport(domainId, span),
		refetchInterval: 60_000,
		placeholderData: keepPreviousData,
	})

export const Route = createFileRoute('/analytics/$domainId/')({ component: Overview })

const SNIPPET = '<script defer src="/_vx/script.js"></script>'

function Overview() {
	const { domainId } = Route.useParams()
	const { span, addFilter } = useSpan()
	const report = useQuery(reportQuery(domainId, span))

	if (!report.data) {
		return report.error ? (
			<ErrorText error={report.error} />
		) : (
			<Skeleton label='Loading the report' className='p-5' />
		)
	}
	const body = report.data
	return (
		<div className='flex flex-col gap-4'>
			<ErrorText error={report.error} />
			<Readings report={body.report} previous={body.previous} />
			{body.report.visitors === 0 ? (
				<NoVisits description='Add the script below to the site, then open a page on it.' />
			) : (
				<TrafficChart body={body} />
			)}
			<Breakdowns report={body.report} onPick={addFilter}>
				<Annotations domainId={domainId} annotations={body.annotations} />
				<Install />
			</Breakdowns>
		</div>
	)
}

const sourceIcon = { x: IconBrandX, reddit: IconBrandReddit } as const

/** Notes on the chart and the X and Reddit posts the scheduler found, newest first. */
function Annotations({ domainId, annotations }: { domainId: string; annotations: Annotation[] }) {
	const queryClient = useQueryClient()
	const [open, setOpen] = useState(false)
	const [text, setText] = useState('')
	const refresh = () => queryClient.invalidateQueries({ queryKey: ['analytics', domainId] })
	const add = useMutation({
		mutationFn: () => api.createAnnotation(domainId, text),
		onSuccess: () => {
			setOpen(false)
			setText('')
			void refresh()
		},
	})
	const remove = useMutation({
		mutationFn: (id: string) => api.deleteAnnotation(domainId, id),
		onSuccess: refresh,
	})
	const newest = annotations.toReversed()

	return (
		<section className='flex min-w-0 flex-col rounded-surface border bg-surface p-4'>
			<header className='mb-3 flex h-8 items-center justify-between gap-4'>
				<h2 className='font-medium'>Annotations</h2>
				<Button onClick={() => setOpen(true)}>
					<IconPlus size={16} stroke={1.75} />
					Add note
				</Button>
			</header>
			<ErrorText error={remove.error} />
			{newest.length === 0 ? (
				<p className='px-2 py-6 text-center text-sm text-muted'>
					Notes you add and posts linking to the site show up on the chart.
				</p>
			) : (
				<ol className='flex flex-col gap-1'>
					{newest.map(note => {
						const Icon =
							note.source === 'x' || note.source === 'reddit' ? sourceIcon[note.source] : IconNote
						return (
							<li key={note.id} className='flex items-center gap-2 px-2 py-1 text-sm'>
								<Icon size={16} stroke={1.75} className='shrink-0 text-muted' />
								{note.url ? (
									<a
										href={note.url}
										target='_blank'
										rel='noreferrer'
										className='min-w-0 truncate hover:underline'
									>
										{annotationTitle(note)}
										{note.source === 'x' ? <span className='text-muted'> {note.text}</span> : null}
									</a>
								) : (
									<span className='min-w-0 truncate'>{annotationTitle(note)}</span>
								)}
								<span className='ml-auto shrink-0'>
									<RelativeTime at={note.at} />
								</span>
								<Confirm title='Delete this annotation?' onConfirm={() => remove.mutate(note.id)}>
									<IconButton label='Delete' icon={IconTrash} />
								</Confirm>
							</li>
						)
					})}
				</ol>
			)}
			<FormDialog
				open={open}
				onOpenChange={setOpen}
				title='Add a note'
				description='Marks this moment on the chart: a launch, a post, a price change.'
				action='Add'
				icon={IconPlus}
				mutation={add}
				onSubmit={() => add.mutate()}
			>
				<Field label='Note'>
					<Input value={text} maxLength={500} required onChange={event => setText(event.target.value)} />
				</Field>
			</FormDialog>
		</section>
	)
}

function Install() {
	const { domainId } = Route.useParams()
	return (
		<section className='flex min-w-0 flex-col gap-3 rounded-surface border bg-surface p-4'>
			<h2 className='flex h-8 items-center font-medium'>Install</h2>
			<p className='text-sm text-muted'>
				Add this to every page. It loads from the site&apos;s own hostname, which Vexdock routes to the manager.
				Add <code className='font-mono text-xs'>data-cookieless</code> to the tag to set no cookie.
			</p>
			<CodeBlock filename='index.html' language='html' code={SNIPPET} />
			<p className='text-sm text-muted'>
				Count a goal with <code className='font-mono text-xs'>window.vx(&apos;signup&apos;)</code> or a{' '}
				<code className='font-mono text-xs'>data-vx-goal=&quot;signup&quot;</code> attribute on a button. For
				revenue, connect a payment provider in Settings, or post each payment to{' '}
				<code className='font-mono text-xs'>POST /api/domains/{domainId}/payments</code> with the buyer&apos;s{' '}
				<code className='font-mono text-xs'>vx_vid</code> cookie as{' '}
				<code className='font-mono text-xs'>visitor_id</code>.
			</p>
		</section>
	)
}
