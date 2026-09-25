import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
	IconArrowDown,
	IconCheck,
	IconDownload,
	IconEraser,
	IconPlayerPause,
	IconPlayerPlay,
	IconSearch,
	IconTextWrap,
	IconX,
} from '@tabler/icons-react'
import { ButtonGroup } from '@/components/ui/button-group'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { cn } from '@/utils/cn'
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
import { IconButton, Segmented } from './primitives'

export type Line = { stream: string; text: string }

const MAX_LINES = 5000

/** HTTP status classes read faster as color than as three digits. */
const statusColor: Record<string, string> = {
	'2': 'text-emerald-400',
	'3': 'text-sky-400',
	'4': 'text-amber-400',
	'5': 'text-red-400',
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
	error: 'text-red-400',
	warn: 'text-amber-400',
	info: 'text-sky-400',
	debug: 'text-console-muted',
}

/** Only the two that want attention get a gutter; the rest would be a stripe down the whole console. */
const gutterColor: Partial<Record<Severity, string>> = {
	error: 'bg-red-400',
	warn: 'bg-amber-400',
}

const levelFilters = [
	{ value: 'all', label: 'All' },
	{ value: 'warn', label: 'Warn+' },
	{ value: 'error', label: 'Errors' },
] as const

type LevelFilter = (typeof levelFilters)[number]['value']

/**
 * How loud a line is. A stderr line is an error whatever it says, an access log
 * takes its class from the status code, everything else from its own level word.
 */
function severityFrom(stream: string, level: string | null, status: string | undefined): Severity | undefined {
	if (stream === 'stderr') return 'error'
	if (level) return levelSeverity[level]
	if (status?.startsWith('5')) return 'error'
	if (status?.startsWith('4')) return 'warn'
	return undefined
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
	className,
}: { className?: string; build?: boolean } & ({ url: string; lines?: never } | { lines: Line[]; url?: never })) {
	const [streamed, setStreamed] = useState<Line[]>([])
	const [paused, setPaused] = useState(false)
	const [filter, setFilter] = useState('')
	const [level, setLevel] = useState<LevelFilter>('all')
	const [follow, setFollow] = useState(true)
	const [plain, setPlain] = useState(false)
	const bottomRef = useRef<HTMLDivElement>(null)
	// Lines land in a ref and flush on a timer: a chatty container emits faster
	// than React can render, and one setState per line re-renders every row.
	const pending = useRef<Line[]>([])
	const flushTimer = useRef(0)
	// A reconnect replays the server's tail=200, so the buffer restarts at the
	// first line of the new stream rather than growing a second copy of it.
	const restart = useRef(false)

	// Pausing keeps the stream open. Reopening it would replay the server's
	// tail=200 and duplicate everything already on screen.
	const connected = useEventSource(url ?? null, {
		log: data => {
			if (paused) return
			if (restart.current) {
				restart.current = false
				pending.current = []
				setStreamed([])
			}
			pending.current.push(data as Line)
			if (flushTimer.current) return
			flushTimer.current = window.setTimeout(() => {
				flushTimer.current = 0
				const batch = pending.current
				pending.current = []
				setStreamed(current => {
					const next = current.concat(batch)
					return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
				})
			}, 200)
		},
	})

	useEffect(() => {
		if (!connected) restart.current = true
	}, [connected])

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

	useEffect(() => {
		if (follow) bottomRef.current?.scrollIntoView({ block: 'end' })
	}, [visible.length, follow])

	return (
		<div>
			<div className='mb-2 flex flex-wrap items-center gap-2'>
				<InputGroup className='h-8 w-56'>
					<InputGroupAddon>
						<IconSearch />
					</InputGroupAddon>
					<InputGroupInput
						value={filter}
						placeholder='Search'
						aria-label='Search lines'
						onChange={event => setFilter(event.target.value)}
						className='text-body'
					/>
				</InputGroup>
				<Segmented value={level} options={levelFilters} onChange={setLevel} />
				<ButtonGroup>
					{url ? (
						<>
							<IconButton
								icon={paused ? IconPlayerPlay : IconPlayerPause}
								label={paused ? 'Resume' : 'Pause'}
								variant='default'
								size='default'
								onClick={() => setPaused(value => !value)}
							/>
							<IconButton
								icon={IconArrowDown}
								label={follow ? 'Stop following' : 'Follow'}
								variant='default'
								size='default'
								aria-pressed={follow}
								onClick={() => setFollow(value => !value)}
							/>
						</>
					) : null}
					<IconButton
						icon={IconTextWrap}
						label={plain ? 'Formatted' : 'Plain text'}
						variant='default'
						size='default'
						aria-pressed={plain}
						onClick={() => setPlain(value => !value)}
					/>
					{url ? (
						<IconButton
							icon={IconEraser}
							label='Clear'
							variant='default'
							size='default'
							onClick={() => setStreamed([])}
						/>
					) : null}
					<IconButton
						icon={IconDownload}
						label='Download'
						variant='default'
						size='default'
						onClick={() => download(visible)}
					/>
				</ButtonGroup>
				<span className='text-label text-muted-foreground'>
					{url ? (
						<span
							className={cn(
								'mr-1.5 inline-block size-1.5 rounded-full',
								connected ? 'bg-emerald-400' : 'bg-muted-foreground',
							)}
						/>
					) : null}
					{url ? `${connected ? 'streaming' : 'disconnected'} · ` : ''}
					{visible.length} lines
				</span>
			</div>
			<div
				className={cn(
					'h-[60vh] overflow-auto rounded-xl border border-console-border bg-console p-3 font-mono text-label leading-[1.5] text-console-foreground',
					className,
				)}
			>
				{visible.length === 0 ? (
					<p className='text-console-muted'>{url ? 'Waiting for output…' : 'No output.'}</p>
				) : (
					visible.map((line, index) =>
						plain ? (
							<div key={index} className='break-all whitespace-pre-wrap'>
								{line.text}
							</div>
						) : (
							<LogLine key={index} line={line} build={build} result={steps?.results.get(line)} />
						),
					)
				)}
				<div ref={bottomRef} />
			</div>
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

const LogLine = memo(function LogLine({ line, build, result }: { line: Line; build: boolean; result?: BuildResult }) {
	const { time, timestamp, body, coloredBody, level } = parseLogLine(line.text)
	const request = parseAccessLine(body)
	const severity = severityFrom(line.stream, level, request?.status)
	const tone =
		line.stream === 'stderr' ? 'text-console-stderr' : level && severity ? severityColor[severity] : undefined
	const buildLine = build ? parseBuildLine(coloredBody) : null

	return (
		<div className={cn('flex gap-3', buildLine?.kind === 'step' && 'mt-2 border-t border-console-border pt-1')}>
			<span
				aria-hidden
				className={cn('-ml-1 w-[3px] shrink-0 rounded-full', severity && gutterColor[severity])}
			/>
			{time ? (
				<span className='shrink-0 text-console-muted' title={timestamp ?? undefined}>
					{time}
				</span>
			) : null}
			{request ? (
				<>
					<span className={cn('w-8 shrink-0', statusColor[request.status[0] ?? ''])}>{request.status}</span>
					<span className='w-14 shrink-0 text-console-muted'>{request.method}</span>
					<span className='min-w-0 flex-1 break-all'>{request.path}</span>
					<span className='shrink-0 text-console-muted'>{bytes(request.bytes)}</span>
					<span className='shrink-0 text-console-muted'>{request.client}</span>
				</>
			) : (
				<LineBody text={coloredBody} buildLine={buildLine} result={result} tone={tone} />
			)}
		</div>
	)
})

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
						<StepIcon className={cn('size-3.5', result.failed ? 'text-red-400' : 'text-emerald-400')} />
					) : null}
				</span>
				<span className='min-w-0 flex-1 break-all whitespace-pre-wrap'>
					<span className='text-sky-400'>{buildLine.stage}</span>{' '}
					<span className='font-semibold text-foreground'>{buildLine.command}</span>
				</span>
				<span className='shrink-0 text-console-muted tabular-nums'>{result?.label}</span>
			</>
		)
	}
	if (buildLine) {
		return (
			<>
				<span className='w-12 shrink-0 text-console-muted tabular-nums'>{buildLine.elapsed}</span>
				<Ansi text={buildLine.text} className={tone} />
			</>
		)
	}
	return <Ansi text={text} className={tone} />
}

function Ansi({ text, className }: { text: string; className?: string }) {
	return (
		<span className={cn('min-w-0 break-all whitespace-pre-wrap', className)}>
			{ansiSegments(text).map((segment, index) =>
				segment.color || segment.bold ? (
					<span key={index} className={cn(segment.bold && 'font-semibold')} style={{ color: segment.color }}>
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
	anchor.download = `logs-${new Date().toISOString().slice(0, 19)}.txt`
	anchor.click()
	URL.revokeObjectURL(url)
}
