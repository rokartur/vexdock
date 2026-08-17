import { useEffect, useRef, useState } from 'react'

import { useEventSource } from '../lib/sse'
import { Button } from './ui'

type Line = { stream: string; text: string }

const MAX_LINES = 5000

/**
 * Live container log tail with client-side search and pause. Logs are streamed
 * from the Docker engine and never stored, so the buffer is capped here.
 */
export function LogViewer({ url }: { url: string }) {
  const [lines, setLines] = useState<Line[]>([])
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  const connected = useEventSource(
    url,
    {
      log: (data) => {
        if (paused) return
        const line = data as Line
        setLines((current) => {
          const next = [...current, line]
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
        })
      },
    },
    !paused,
  )

  const visible = filter ? lines.filter((line) => line.text.toLowerCase().includes(filter.toLowerCase())) : lines

  useEffect(() => {
    if (follow) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [visible.length, follow])

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={filter}
          placeholder="Search"
          onChange={(event) => setFilter(event.target.value)}
          className="!w-56 text-[12px]"
        />
        <Button onClick={() => setPaused((value) => !value)}>{paused ? 'Resume' : 'Pause'}</Button>
        <Button onClick={() => setFollow((value) => !value)}>{follow ? 'Unfollow' : 'Follow'}</Button>
        <Button onClick={() => setLines([])}>Clear</Button>
        <Button onClick={() => download(visible)}>Download</Button>
        <span className="text-[11px] text-[#8a8a8a]">
          {connected ? 'streaming' : 'disconnected'} · {visible.length} lines
        </span>
      </div>
      <div className="h-[60vh] overflow-auto border border-[#1f1f1f] bg-[#050505] p-2 font-mono text-[12px] leading-[1.4]">
        {visible.length === 0 ? (
          <p className="text-[#5a5a5a]">Waiting for output…</p>
        ) : (
          visible.map((line, index) => (
            <div key={index} className={line.stream === 'stderr' ? 'text-[#ff8a80]' : 'text-[#d4d4d4]'}>
              {line.text}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function download(lines: Line[]) {
  const blob = new Blob([lines.map((line) => line.text).join('\n')], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `logs-${new Date().toISOString().slice(0, 19)}.txt`
  anchor.click()
  URL.revokeObjectURL(url)
}
