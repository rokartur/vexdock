import { useState } from 'react'
import { IconBrandReddit, IconBrandX, IconNote, IconPlus, IconTrash } from '@tabler/icons-react'
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { cn } from 'cn'
import { CodeBlock } from '@/components/ui/code-block'
import {
	Breakdowns,
	NoVisits,
	Readings,
	ReportCard,
	ReportSkeleton,
	TrafficChart,
	annotationTitle,
} from '../components/analytics-report'
import {
	Button,
	Confirm,
	EmptyState,
	ErrorText,
	Field,
	FormDialog,
	IconButton,
	Input,
	RelativeTime,
	textLink,
} from '../components/primitives'
import { type AnalyticsSpan, type Annotation, api } from '../lib/api'
import { useSpan } from './analytics.$domainId'

const reportQuery = (domainId: string, span: AnalyticsSpan) =>
	queryOptions({
		queryKey: ['analytics', domainId, 'report', span],
		queryFn: () => api.analyticsReport(domainId, span),
		placeholderData: keepPreviousData,
	})

export const Route = createFileRoute('/analytics/$domainId/')({ component: Overview })

const SNIPPET = '<script defer src="/_vx/script.js"></script>'

function Overview() {
	const { domainId } = Route.useParams()
	const { span, addFilter } = useSpan()
	const report = useQuery(reportQuery(domainId, span))

	if (!report.data) return report.error ? <ErrorText error={report.error} /> : <ReportSkeleton />
	const body = report.data
	return (
		<div className='flex flex-col gap-4'>
			<ErrorText error={report.error} />
			<Readings report={body.report} previous={body.previous} />
			{body.report.visitors === 0 ? (
				<NoVisits description='Nobody visited in this range. If no range shows a visit, add the script below to the site.' />
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
		<ReportCard
			title='Notes'
			actions={
				<Button variant='primary' size='sm' onClick={() => setOpen(true)}>
					<IconPlus size={16} stroke={1.75} />
					Add note
				</Button>
			}
		>
			<ErrorText error={remove.error} />
			{newest.length === 0 ? (
				<EmptyState
					icon={IconNote}
					title='No notes yet'
					description='Add note marks a day on the chart; posts linking to the site show up there too.'
				/>
			) : (
				<ol className='flex flex-col gap-1'>
					{newest.map(note => {
						const Icon =
							note.source === 'x' || note.source === 'reddit' ? sourceIcon[note.source] : IconNote
						const post = Icon !== IconNote
						return (
							<li key={note.id} className='flex items-start gap-2 px-2 py-1 text-sm'>
								<Icon size={16} stroke={1.75} className='mt-0.5 shrink-0 text-muted' />
								{note.url ? (
									<a
										href={note.url}
										target='_blank'
										rel='noreferrer'
										className={cn(textLink, 'min-w-0 wrap-anywhere')}
									>
										{annotationTitle(note)}
										{note.source === 'x' ? <span className='text-muted'> {note.text}</span> : null}
									</a>
								) : (
									<span className='min-w-0 wrap-anywhere'>{annotationTitle(note)}</span>
								)}
								<span className='ml-auto shrink-0'>
									<RelativeTime at={note.at} />
								</span>
								<Confirm
									title={post ? 'Remove this post from the chart?' : 'Delete this note?'}
									description={
										post
											? 'It comes back if the next mention search still finds it.'
											: 'It leaves the chart for good.'
									}
									action={post ? 'Remove post' : 'Delete note'}
									onConfirm={() => remove.mutate(note.id)}
								>
									<IconButton
										label={`${post ? 'Remove' : 'Delete'} ${annotationTitle(note)}`}
										icon={IconTrash}
										loading={remove.isPending && remove.variables === note.id}
										disabled={remove.isPending}
									/>
								</Confirm>
							</li>
						)
					})}
				</ol>
			)}
			<FormDialog
				open={open}
				onOpenChange={next => {
					setOpen(next)
					if (!next) setText('')
				}}
				title='Add a note'
				description='Marks this moment on the chart: a launch, a post, a price change.'
				action='Add note'
				icon={IconPlus}
				mutation={add}
				onSubmit={() => add.mutate()}
			>
				<Field label='Note'>
					<Input value={text} maxLength={500} required onChange={event => setText(event.target.value)} />
				</Field>
			</FormDialog>
		</ReportCard>
	)
}

function Install() {
	const { domainId } = Route.useParams()
	return (
		<ReportCard title='Install'>
			<div className='flex flex-col gap-3'>
				<p className='text-sm text-muted'>
					Add this to every page. It loads from the site&apos;s own hostname, which Vexdock routes to the
					manager. Add <code className='font-mono text-xs'>data-cookieless</code> to the tag to set no cookie.
				</p>
				<CodeBlock filename='index.html' language='html' code={SNIPPET} />
				<p className='text-sm text-muted'>
					Count a goal with <code className='font-mono text-xs'>window.vx(&apos;signup&apos;)</code> or a{' '}
					<code className='font-mono text-xs'>data-vx-goal=&quot;signup&quot;</code> attribute on a button.
					For revenue, connect a payment provider in{' '}
					<Link to='/analytics/$domainId/settings' params={{ domainId }} className={textLink}>
						Settings
					</Link>
					, or post each payment to{' '}
					<code className='font-mono text-xs wrap-anywhere'>POST /api/domains/{domainId}/payments</code> with
					the buyer&apos;s <code className='font-mono text-xs'>vx_vid</code> cookie as{' '}
					<code className='font-mono text-xs'>visitor_id</code>.
				</p>
			</div>
		</ReportCard>
	)
}
