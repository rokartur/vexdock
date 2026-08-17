import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

/**
 * Interactive container shell. The manager attaches a Docker exec over
 * WebSocket, trying bash and falling back to sh.
 */
export function Terminal({ url }: { url: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XTerm({
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      theme: { background: '#050505', foreground: '#d4d4d4', cursor: '#ffffff' },
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
    socket.onmessage = (event) => {
      const data =
        typeof event.data === 'string' ? event.data : decoder.decode(new Uint8Array(event.data as ArrayBuffer))
      term.write(data)
    }
    socket.onclose = () => {
      setStatus('closed')
      term.write('\r\n\x1b[90mconnection closed\x1b[0m\r\n')
    }

    const inputDisposable = term.onData((data) => {
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
      <div className="mb-2 text-[12px] text-[#8a8a8a]">{status}</div>
      <div ref={hostRef} className="terminal-host h-[60vh] border border-[#1f1f1f] bg-[#050505]" />
    </div>
  )
}
