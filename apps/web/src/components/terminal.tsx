import { useEffect, useRef, useState } from 'react'
import { IconRefresh } from '@tabler/icons-react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import { Button, Status } from './primitives'

/**
 * Interactive container shell. The manager attaches a Docker exec over
 * WebSocket, trying bash and falling back to sh.
 */
export function Terminal({ url }: { url: string }) {
	const hostRef = useRef<HTMLDivElement>(null)
	const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'refused'>('connecting')
	// Bumped by Reconnect: a new session is a new socket and a fresh screen.
	const [session, setSession] = useState(0)
	const statusText = {
		connecting: 'Connecting',
		open: 'Connected',
		closed: 'Disconnected',
		refused: 'Could not connect. Start the service, then reconnect.',
	}[status]

	useEffect(() => {
		const host = hostRef.current
		if (!host) return

		// xterm paints on a canvas, so it needs literal colors: read them off the
		// console tokens in styles.css instead of duplicating the palette here.
		const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
		const term = new XTerm({
			convertEol: true,
			// Mirrors the canvas into an accessible DOM, so a screen reader hears what the shell answers.
			screenReaderMode: true,
			fontFamily: token('--font-mono'),
			fontSize: 12,
			theme: {
				background: token('--console'),
				foreground: token('--console-foreground'),
				cursor: token('--foreground'),
			},
		})
		const fit = new FitAddon()
		term.loadAddon(fit)
		term.open(host)
		fit.fit()

		const socket = new WebSocket(url)
		socket.binaryType = 'arraybuffer'

		const sendResize = () => {
			fit.fit()
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
			}
		}

		let opened = false
		socket.onopen = () => {
			opened = true
			setStatus('open')
			sendResize()
			term.focus()
		}
		socket.onmessage = event => {
			// Raw bytes: a Docker chunk can split a UTF-8 character, and xterm keeps its decoder state across writes.
			term.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer))
		}
		// A refused upgrade (no running container, another origin) closes before it opens, and the browser hides why.
		socket.onclose = () => {
			setStatus(opened ? 'closed' : 'refused')
			const note = opened ? 'connection closed' : 'could not open a shell'
			term.write(`\r\n\u001B[90m${note}\u001B[0m\r\n`)
		}

		const inputDisposable = term.onData(data => {
			if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
		})

		const observer = new ResizeObserver(sendResize)
		observer.observe(host)

		return () => {
			observer.disconnect()
			inputDisposable.dispose()
			// The close this causes arrives after the next session's socket, and would mark that one closed.
			socket.onclose = null
			socket.close()
			term.dispose()
		}
	}, [url, session])

	return (
		<div>
			<div className='mb-2 flex min-h-8 items-center gap-3'>
				<div role='status' className='flex items-center gap-1.5 text-xs text-muted'>
					{/* The words beside it are the status; the dot only repeats its tone. */}
					<span aria-hidden className='flex'>
						<Status value={status} dot />
					</span>
					{statusText}
				</div>
				{status === 'closed' || status === 'refused' ? (
					<Button
						size='sm'
						onClick={() => {
							setStatus('connecting')
							setSession(session + 1)
						}}
					>
						<IconRefresh size={16} stroke={1.75} />
						Reconnect shell
					</Button>
				) : null}
			</div>
			<div
				ref={hostRef}
				className='terminal-host h-[60dvh] overflow-hidden rounded-surface border bg-console p-2 transition-colors focus-within:border-foreground'
			/>
		</div>
	)
}
