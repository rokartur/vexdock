import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { api } from '../lib/api'

type Entry = { to: string; label: string; hint: string }

/**
 * Command palette over navigation and projects. Opened with Cmd/Ctrl+K, closed
 * with Escape, navigates with Enter.
 */
export function CommandPalette({ links, onClose }: { links: { to: string; label: string }[]; onClose: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, staleTime: 30_000 })

  const entries = useMemo<Entry[]>(() => {
    const base: Entry[] = links.map((link) => ({ ...link, hint: 'page' }))
    const projectEntries: Entry[] =
      projects.data?.map((project) => ({
        to: `/projects/${project.id}`,
        label: project.name,
        hint: 'project',
      })) ?? []
    const all = [...base, ...projectEntries]
    const needle = query.trim().toLowerCase()
    if (!needle) return all
    return all.filter((entry) => entry.label.toLowerCase().includes(needle) || entry.to.includes(needle))
  }, [links, projects.data, query])

  const go = (entry: Entry | undefined) => {
    if (!entry) return
    void navigate({ to: entry.to })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 pt-[12vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg border border-[#2e2e2e] bg-black"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <input
          autoFocus
          value={query}
          placeholder="Jump to…"
          onChange={(event) => {
            setQuery(event.target.value)
            setCursor(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setCursor((c) => Math.min(c + 1, entries.length - 1))
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              go(entries[cursor])
            }
          }}
          className="!rounded-none !border-0 !border-b !border-[#1f1f1f] px-3 py-2.5 text-[13px]"
        />
        <ul className="max-h-80 overflow-y-auto">
          {entries.length === 0 ? (
            <li className="px-3 py-2 text-[12px] text-[#8a8a8a]">No matches</li>
          ) : (
            entries.map((entry, index) => (
              <li key={`${entry.to}-${entry.label}`}>
                <button
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => go(entry)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] ${
                    index === cursor ? 'bg-[#141414] text-white' : 'text-[#c4c4c4]'
                  }`}
                >
                  <span>{entry.label}</span>
                  <span className="font-mono text-[10px] text-[#5a5a5a]">{entry.hint}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}
