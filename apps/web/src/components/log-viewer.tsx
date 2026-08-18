import { useEffect, useRef, useState } from 'react'
import { cn } from '@/utils/cn'
import { bytes, parseAccessLine, parseLogLine } from '../lib/format'
import { useEventSource } from '../lib/sse'
import { Button } from './primitives'

type Line = { stream: string; text: string }

const MAX_LINES = 5000

/** HTTP status classes read faster as colour than as three digits. */
const statusColor: Record<string, string> = {
	'2': 'text-emerald-400',
	'3': 'text-sky-400',
	'4': 'text-amber-400',
	'5': 'text-red-400',
}

const levelColor: Record<string, string> = {
	emerg: 'text-red-400',
	alert: 'text-red-400',
	crit: 'text-red-400',
	fatal: 'text-red-400',
	panic: 'text-red-400',
	error: 'text-red-400',
	err: 'text-red-400',
	warning: 'text-amber-400',
	warn: 'text-amber-400',
	notice: 'text-sky-400',
	info: 'text-sky-400',
	debug: 'text-console-muted',
	trace: 'text-console-muted',
}

/**
 * Live container log tail with client-side search and pause. Logs are streamed
 * from the Docker engine and never stored, so the buffer is capped here.
 */
export function LogViewer({ url }: { url: string }) {
	const [lines, setLines] = useState<Line[]>([])
	const [paused, setPaused] = useState(false)
	const [filter, setFilter] = useState('')
	const [follow, setFollow] = useState(true)
	const [plain, setPlain] = useState(false)
	const bottomRef = useRef<HTMLDivElement>(null)

	const connected = useEventSource(
		url,
		{
			log: data => {
				if (paused) return
				const line = data as Line
				setLines(current => {
					const next = [...current, line]
					return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
				})
			},
		},
		!paused,
	)

	const visible = filter ? lines.filter(line => line.text.toLowerCase().includes(filter.toLowerCase())) : lines

	useEffect(() => {
		if (follow) bottomRef.current?.scrollIntoView({ block: 'end' })
	}, [visible.length, follow])

	return (
		<div>
			<div className='mb-2 flex flex-wrap items-center gap-2'>
				<input
					value={filter}
					placeholder='Search'
					onChange={event => setFilter(event.target.value)}
					className='!w-56 text-body'
				/>
				<Button onClick={() => setPaused(value => !value)}>{paused ? 'Resume' : 'Pause'}</Button>
				<Button onClick={() => setFollow(value => !value)}>{follow ? 'Unfollow' : 'Follow'}</Button>
				<Button onClick={() => setPlain(value => !value)}>{plain ? 'Formatted' : 'Plain text'}</Button>
				<Button onClick={() => setLines([])}>Clear</Button>
				<Button onClick={() => download(visible)}>Download</Button>
				<span className='text-label text-muted-foreground'>
					{connected ? 'streaming' : 'disconnected'} · {visible.length} lines
				</span>
			</div>
			<div className='h-[60vh] overflow-auto border border-console-border bg-console p-2 font-mono text-body leading-[1.4] text-console-foreground'>
				{visible.length === 0 ? (
					<p className='text-console-muted'>Waiting for output…</p>
				) : (
					visible.map((line, index) =>
						plain ? (
							<div key={index} className='break-all whitespace-pre-wrap'>
								{line.text}
							</div>
						) : (
							<LogLine key={index} line={line} />
						),
					)
				)}
				<div ref={bottomRef} />
			</div>
		</div>
	)
}

function LogLine({ line }: { line: Line }) {
	const { time, timestamp, body, level } = parseLogLine(line.text)
	const request = parseAccessLine(body)
	const tone = line.stream === 'stderr' ? 'text-console-stderr' : level ? levelColor[level] : undefined

	return (
		<div className='flex gap-3'>
			{time ? (
				<span className='shrink-0 text-console-muted tabular-nums' title={timestamp ?? undefined}>
					{time}
				</span>
			) : null}
			{request ? (
				<>
					<span className={cn('w-8 shrink-0 tabular-nums', statusColor[request.status[0] ?? ''])}>
						{request.status}
					</span>
					<span className='w-14 shrink-0 text-console-muted'>{request.method}</span>
					<span className='min-w-0 flex-1 break-all'>{request.path}</span>
					<span className='shrink-0 text-console-muted tabular-nums'>{bytes(request.bytes)}</span>
					<span className='shrink-0 text-console-muted'>{request.client}</span>
				</>
			) : (
				<span className={cn('min-w-0 break-all whitespace-pre-wrap', tone)}>{body}</span>
			)}
		</div>
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
