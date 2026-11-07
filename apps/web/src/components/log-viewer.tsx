import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
	IconArrowDown,
	IconCheck,
	IconDownload,
	IconEraser,
	IconFilterOff,
	IconPlayerPause,
	IconPlayerPlay,
	IconTextWrap,
	IconX,
} from '@tabler/icons-react'
import { cn } from 'cn'
import { ButtonGroup } from '@/components/ui/button-group'
import { SearchField } from '@/components/ui/search-field'
import {
	type BuildResult,
	ansiSegments,
	bytes,
	parseAccessLine,
	parseBuildLine,
	parseBuildResult,
	parseLogLine,
} from '../lib/format'
import { useEventSource } from '../lib/sse'
import { Button, Segmented, Select } from './primitives'

// `seq` is set on streamed lines: the buffer drops its oldest, so a line's position is not its key.
export type Line = { stream: string; text: string; seq?: number }

/** One number is both the server's `tail` and the buffer's cap, so the view holds exactly the last N lines. */
const lineLimits = [
	{ value: '100', label: '100 lines' },
	{ value: '500', label: '500 lines' },
	{ value: '1000', label: '1000 lines' },
	{ value: '5000', label: '5000 lines' },
] as const

type LineLimit = (typeof lineLimits)[number]['value']

/** HTTP status classes read faster as color than as three digits. */
const statusColor: Record<string, string> = {
	'2': 'text-success',
	'3': 'text-accent',
	'4': 'text-warning',
	'5': 'text-danger',
}

type Severity = 'error' | 'warn' | 'info' | 'debug'

/** One table, so the word's color and the line's gutter can never disagree. */
const levelSeverity: Record<string, Severity> = {
	emerg: 'error',
	alert: 'error',
	crit: 'error',
	fatal: 'error',
	panic: 'error',
	error: 'error',
	err: 'error',
	warning: 'warn',
	warn: 'warn',
	notice: 'info',
	info: 'info',
	debug: 'debug',
	trace: 'debug',
}

const severityColor: Record<Severity, string> = {
	error: 'text-danger',
	warn: 'text-warning',
	info: 'text-accent',
	debug: 'text-muted',
}

/** Only the two that want attention get a gutter; the rest would be a stripe down the whole console. */
const gutterColor: Partial<Record<Severity, string>> = {
	error: 'bg-danger',
	warn: 'bg-warning',
}

const levelFilters = [
	{ value: 'all', label: 'All' },
	{ value: 'warn', label: 'Warn+' },
	{ value: 'error', label: 'Errors' },
] as const

type LevelFilter = (typeof levelFilters)[number]['value']

/**
 * How loud a line is. Its own level word decides first (nginx and Postgres log routine notices to stderr), an
 * access log takes its class from the status code, and any other stderr line is an error.
 */
function severityFrom(stream: string, level: string | null, status: string | undefined): Severity | undefined {
	if (level) return levelSeverity[level]
	if (status?.startsWith('5')) return 'error'
	if (status?.startsWith('4')) return 'warn'
	if (stream === 'stderr' && !status) return 'error'
	return undefined
}

/** Recorded output as lines: blank lines are what the command printed, only the final newline's empty tail goes. */
export function outputLines(output: string): Line[] {
	if (output === '') return []
	return output
		.replace(/\n$/u, '')
		.split('\n')
		.map(text => ({ stream: 'stdout', text }))
}

export function severityOf(line: Line): Severity | undefined {
	const { body, level } = parseLogLine(line.text)
	return severityFrom(line.stream, level, parseAccessLine(body)?.status)
}

/**
 * `url` tails an SSE endpoint; streamed logs are never stored, so the buffer is
 * capped here. `lines` renders output the caller already holds. `build` reads
 * BuildKit's `#N` lines as steps.
 */
export function LogViewer({
	url,
	lines: given,
	build = false,
	inset = false,
	waiting = false,
	className,
}: {
	className?: string
	build?: boolean
	// Given `lines`, the caller still expects more: an empty log reads as waiting, not as finished.
	waiting?: boolean
	// Inside a dialog body (p-4), where the box takes the concentric corner instead of a card's.
	inset?: boolean
} & ({ url: string; lines?: never } | { lines: Line[]; url?: never })) {
	const [streamed, setStreamed] = useState<Line[]>([])
	const [paused, setPaused] = useState(false)
	const [filter, setFilter] = useState('')
	const [level, setLevel] = useState<LevelFilter>('all')
	const [follow, setFollow] = useState(true)
	const [plain, setPlain] = useState(false)
	const [limit, setLimit] = useState<LineLimit>('1000')
	const boxRef = useRef<HTMLDivElement>(null)
	// Lines land in a ref and flush on a timer: a chatty container emits faster
	// than React can render, and one setState per line re-renders every row.
	const pending = useRef<Line[]>([])
	const flushTimer = useRef(0)
	// A reconnect, or a new limit, replays the server's tail, so the buffer restarts
	// at the first line of the new stream rather than growing a second copy of it.
	const restart = useRef(false)
	// The lines waiting in `pending` open a new stream, so their flush replaces the screen instead of extending it.
	const fresh = useRef(false)
	const nextSeq = useRef(0)
	const cap = Number(limit)

	const flush = () => {
		clearTimeout(flushTimer.current)
		flushTimer.current = 0
		const batch = pending.current
		const replace = fresh.current
		pending.current = []
		fresh.current = false
		setStreamed(current => (replace ? batch : [...current, ...batch]).slice(-cap))
	}

	// Pausing keeps the stream open and holds its lines back. Reopening it would replay the server's
	// tail and duplicate everything already on screen.
	const stream = useEventSource(url ? `${url}?tail=${limit}` : null, {
		// EventSource fires `open` on every (re)connect, the browser's own retries included.
		open: () => {
			restart.current = true
		},
		log: data => {
			if (restart.current) {
				restart.current = false
				pending.current = []
				fresh.current = true
			}
			nextSeq.current += 1
			pending.current.push({ ...(data as Line), seq: nextSeq.current })
			// A long pause on a chatty container: only the newest `cap` lines could reach the screen anyway.
			if (pending.current.length > 2 * cap) pending.current = pending.current.slice(-cap)
			if (paused || flushTimer.current) return
			flushTimer.current = window.setTimeout(flush, 200)
		},
	})

	useEffect(() => () => clearTimeout(flushTimer.current), [])

	const lines = given ?? streamed
	const needle = filter.toLowerCase()
	const steps = useMemo(() => (build ? buildSteps(lines) : null), [build, lines])
	const visible = useMemo(
		() =>
			lines.filter(line => {
				if (!plain && steps?.closing.has(line)) return false
				if (needle && !line.text.toLowerCase().includes(needle)) return false
				if (level === 'all') return true
				const severity = severityOf(line)
				return level === 'error' ? severity === 'error' : severity === 'error' || severity === 'warn'
			}),
		[lines, needle, level, plain, steps],
	)

	// On every batch, not on a new length: a full buffer keeps its length while its lines move.
	useLayoutEffect(() => {
		// Only the log box scrolls: scrollIntoView would also drag the page and an open dialog to its bottom edge.
		if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
	}, [visible, follow])

	const streamState = paused ? 'paused' : stream
	return (
		<div>
			<div className='mb-2 flex flex-wrap items-center gap-2'>
				<div className='w-56'>
					<SearchField
						label='Search lines'
						hideLabel
						placeholder='Search'
						value={filter}
						onValueChange={setFilter}
					/>
				</div>
				<Segmented label='Level' value={level} options={levelFilters} onChange={setLevel} />
				{url ? (
					<Select value={limit} options={lineLimits} onChange={setLimit} label='Lines' className='w-auto' />
				) : null}
				<ButtonGroup
					label='Log actions'
					items={[
						...(url
							? [
									{
										id: 'pause',
										label: paused ? 'Resume' : 'Pause',
										icon: paused ? (
											<IconPlayerPlay size={16} stroke={1.75} />
										) : (
											<IconPlayerPause size={16} stroke={1.75} />
										),
										onSelect: () => {
											if (paused) flush()
											setPaused(!paused)
										},
									},
									{
										id: 'follow',
										label: 'Follow',
										icon: <IconArrowDown size={16} stroke={1.75} />,
										pressed: follow,
										onSelect: () => setFollow(value => !value),
									},
								]
							: []),
						{
							id: 'plain',
							label: 'Plain text',
							icon: <IconTextWrap size={16} stroke={1.75} />,
							pressed: plain,
							onSelect: () => setPlain(value => !value),
						},
						...(url
							? [
									{
										id: 'clear',
										label: 'Clear log',
										icon: <IconEraser size={16} stroke={1.75} />,
										onSelect: () => setStreamed([]),
									},
								]
							: []),
						{
							id: 'download',
							label: 'Download log',
							icon: <IconDownload size={16} stroke={1.75} />,
							// The whole buffer: a search or level filter narrows the view, not the file.
							onSelect: () => download(lines),
						},
					]}
				/>
				<span className='text-xs text-muted tabular-nums'>
					{url ? (
						<>
							<span
								className={cn(
									'mr-1.5 inline-block size-1.5 rounded-full',
									{
										connecting: 'bg-warning',
										open: 'bg-success',
										lost: 'bg-danger',
										paused: 'bg-muted',
									}[streamState],
								)}
							/>
							<span role='status'>
								{
									{
										connecting: 'Connecting',
										open: 'Streaming',
										lost: 'Reconnecting',
										paused: 'Paused',
									}[streamState]
								}
							</span>
							{' · '}
						</>
					) : null}
					{visible.length.toLocaleString('en-US')} {visible.length === 1 ? 'line' : 'lines'}
				</span>
			</div>
			<div
				ref={boxRef}
				// Keyboard scrolling needs focus, and the box holds only text: Safari would never reach it.
				tabIndex={0}
				role='region'
				aria-label='Log output'
				// Reading back up the stream lets go of the bottom; returning there follows again.
				onScroll={event => {
					const box = event.currentTarget
					const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24
					if (atBottom !== follow) setFollow(atBottom)
				}}
				className={cn(
					'h-[60dvh] overflow-auto border bg-console p-3 font-mono text-xs leading-[1.5] text-console-foreground',
					inset ? 'rounded-[max(6px,calc(var(--radius-surface)-16px))]' : 'rounded-surface',
					className,
				)}
			>
				{visible.length === 0 ? (
					<EmptyLog
						filtered={lines.length > 0 && (needle !== '' || level !== 'all')}
						streaming={Boolean(url) || waiting}
						onClear={() => {
							setFilter('')
							setLevel('all')
						}}
					/>
				) : (
					visible.map((line, index) =>
						plain ? (
							<div key={line.seq ?? index} className='wrap-anywhere whitespace-pre-wrap'>
								{line.text}
							</div>
						) : (
							<LogLine
								key={line.seq ?? index}
								line={line}
								build={build}
								result={steps?.results.get(line)}
							/>
						),
					)
				)}
			</div>
		</div>
	)
}

function EmptyLog({ filtered, streaming, onClear }: { filtered: boolean; streaming: boolean; onClear: () => void }) {
	if (!filtered) return <p className='text-muted'>{streaming ? 'Waiting for output…' : 'No output.'}</p>
	return (
		<div className='flex flex-wrap items-center gap-3 font-sans'>
			<p className='text-muted'>No line matches this search and level.</p>
			<Button size='sm' onClick={onClear}>
				<IconFilterOff size={16} stroke={1.75} />
				Clear filters
			</Button>
		</div>
	)
}

/** Pairs each BuildKit step with the line that closed it, so the step shows the outcome and a clean close can go. */
function buildSteps(lines: Line[]) {
	const opened = new Map<string, Line>()
	const results = new Map<Line, BuildResult>()
	const closing = new Set<Line>()
	for (const line of lines) {
		const buildLine = parseBuildLine(parseLogLine(line.text).coloredBody)
		if (!buildLine) continue
		if (buildLine.kind === 'step') {
			opened.set(buildLine.id, line)
			continue
		}
		const step = opened.get(buildLine.id)
		const result = parseBuildResult(buildLine.text)
		if (!step || !result) continue
		results.set(step, result)
		// An ERROR line carries the reason, so only a clean close is hidden.
		if (!result.failed) closing.add(line)
	}
	return { results, closing }
}

// Every flush re-renders the list; memo keeps the lines already drawn from parsing again.
const LogLine = memo(LogLineRow)

function LogLineRow({ line, build, result }: { line: Line; build: boolean; result?: BuildResult }) {
	const { time, timestamp, body, coloredBody, level } = parseLogLine(line.text)
	const request = parseAccessLine(body)
	const severity = severityFrom(line.stream, level, request?.status)
	const tone = level || line.stream === 'stderr' ? severity && severityColor[severity] : undefined
	const buildLine = build ? parseBuildLine(coloredBody) : null

	return (
		<div className={cn('flex gap-3', buildLine?.kind === 'step' && 'mt-2 border-t border-border pt-1')}>
			<span
				aria-hidden
				className={cn('-ml-1 w-[3px] shrink-0 rounded-full', severity && gutterColor[severity])}
			/>
			{time ? (
				<span className='shrink-0 text-muted' title={timestamp ?? undefined}>
					{time}
				</span>
			) : null}
			{request ? (
				<>
					<span className={cn('w-8 shrink-0', statusColor[request.status[0] ?? ''])}>{request.status}</span>
					<span className='w-14 shrink-0 text-muted'>{request.method}</span>
					<span className='min-w-0 flex-1 wrap-anywhere'>{request.path}</span>
					<span className='shrink-0 text-muted'>{bytes(request.bytes)}</span>
					<span className='shrink-0 text-muted'>{request.client}</span>
				</>
			) : (
				<LineBody text={coloredBody} buildLine={buildLine} result={result} tone={tone} />
			)}
		</div>
	)
}

function LineBody({
	text,
	buildLine,
	result,
	tone,
}: {
	text: string
	buildLine: ReturnType<typeof parseBuildLine>
	result?: BuildResult
	tone?: string
}) {
	if (buildLine?.kind === 'step') {
		const StepIcon = result?.failed ? IconX : IconCheck
		return (
			<>
				<span className='flex h-lh w-12 shrink-0 items-center'>
					{result ? (
						<StepIcon className={cn('size-3.5', result.failed ? 'text-danger' : 'text-success')} />
					) : null}
				</span>
				<span className='min-w-0 flex-1 wrap-anywhere whitespace-pre-wrap'>
					<span className='text-accent'>{buildLine.stage}</span>{' '}
					<span className='font-medium text-foreground'>{buildLine.command}</span>
				</span>
				<span className='shrink-0 text-muted tabular-nums'>{result?.label}</span>
			</>
		)
	}
	if (buildLine) {
		return (
			<>
				<span className='w-12 shrink-0 text-muted tabular-nums'>{buildLine.elapsed}</span>
				<Ansi text={buildLine.text} className={tone} />
			</>
		)
	}
	return <Ansi text={text} className={tone} />
}

function Ansi({ text, className }: { text: string; className?: string }) {
	return (
		<span className={cn('min-w-0 wrap-anywhere whitespace-pre-wrap', className)}>
			{/* Segments of one fixed line never reorder, so their position is their identity. */}
			{ansiSegments(text).map((segment, index) =>
				segment.color || segment.bold ? (
					<span key={index} className={cn(segment.bold && 'font-medium')} style={{ color: segment.color }}>
						{segment.text}
					</span>
				) : (
					segment.text
				),
			)}
		</span>
	)
}

function download(lines: Line[]) {
	const blob = new Blob([lines.map(line => line.text).join('\n')], { type: 'text/plain' })
	const url = URL.createObjectURL(blob)
	const anchor = document.createElement('a')
	anchor.href = url
	anchor.download = `logs-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.txt`
	anchor.click()
	URL.revokeObjectURL(url)
}
