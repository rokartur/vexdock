import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import { cn } from '@/utils/cn'

/**
 * Interactive container shell. The manager attaches a Docker exec over
 * WebSocket, trying bash and falling back to sh.
 */
export function Terminal({ url }: { url: string }) {
	const hostRef = useRef<HTMLDivElement>(null)
	const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting')
	const statusDot = { connecting: 'bg-amber-400', open: 'bg-emerald-400', closed: 'bg-muted-foreground' }[status]

	useEffect(() => {
		const host = hostRef.current
		if (!host) return

		// xterm paints on a canvas, so it needs literal colours: read them off the
		// console tokens in styles.css instead of duplicating the palette here.
		const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
		const term = new XTerm({
			convertEol: true,
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
		const decoder = new TextDecoder()

		const sendResize = () => {
			fit.fit()
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
			}
		}

		socket.onopen = () => {
			setStatus('open')
			sendResize()
			term.focus()
		}
		socket.onmessage = event => {
			const data =
				typeof event.data === 'string' ? event.data : decoder.decode(new Uint8Array(event.data as ArrayBuffer))
			term.write(data)
		}
		socket.onclose = () => {
			setStatus('closed')
			term.write('\r\n\u001B[90mconnection closed\u001B[0m\r\n')
		}

		const inputDisposable = term.onData(data => {
			if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
		})

		const observer = new ResizeObserver(sendResize)
		observer.observe(host)

		return () => {
			observer.disconnect()
			inputDisposable.dispose()
			socket.close()
			term.dispose()
		}
	}, [url])

	return (
		<div>
			<div className='mb-2 flex items-center gap-1.5 text-label text-muted-foreground'>
				<span className={cn('inline-block size-1.5 rounded-full', statusDot)} />
				{status}
			</div>
			<div
				ref={hostRef}
				className='terminal-host h-[60vh] overflow-hidden rounded-xl border border-console-border bg-console p-2'
			/>
		</div>
	)
}
