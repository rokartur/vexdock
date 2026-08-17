import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { api } from '../lib/api'
import { CommandPalette } from './command-palette'

type NavItem = { to: string; label: string }

const navigation: { group: string; items: NavItem[] }[] = [
  {
    group: 'Platform',
    items: [
      { to: '/', label: 'Dashboard' },
      { to: '/projects', label: 'Projects' },
      { to: '/domains', label: 'Domains' },
    ],
  },
  {
    group: 'Docker',
    items: [
      { to: '/docker/containers', label: 'Containers' },
      { to: '/docker/images', label: 'Images' },
      { to: '/docker/volumes', label: 'Volumes' },
      { to: '/docker/networks', label: 'Networks' },
    ],
  },
  {
    group: 'System',
    items: [
      { to: '/system', label: 'Overview' },
      { to: '/system/docker', label: 'Cleanup' },
      { to: '/system/backups', label: 'Backups' },
      { to: '/system/update', label: 'Update' },
      { to: '/system/settings', label: 'Settings' },
    ],
  },
]

/** Sidebar plus content. The sidebar collapses to a top bar on small screens. */
export function Shell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  const version = useQuery({ queryKey: ['version'], queryFn: api.version, staleTime: 60_000 })
  const session = useQuery({ queryKey: ['auth', 'me'], queryFn: api.me, staleTime: Infinity })

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      queryClient.clear()
      await navigate({ to: '/login', replace: true })
    },
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
      if (event.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const links = useMemo(() => navigation.flatMap((group) => group.items), [])

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="shrink-0 border-b border-[#1f1f1f] md:h-screen md:w-52 md:border-r md:border-b-0">
        <div className="flex h-11 items-center justify-between border-b border-[#1f1f1f] px-3">
          <Link to="/" className="text-[13px] font-medium tracking-tight">
            platform
          </Link>
          <button
            onClick={() => setPaletteOpen(true)}
            className="rounded-[2px] border border-[#1f1f1f] px-1.5 py-0.5 font-mono text-[10px] text-[#8a8a8a] hover:border-[#2e2e2e]"
            title="Command palette"
          >
            ⌘K
          </button>
        </div>

        <nav className="px-2 py-3">
          {navigation.map((group) => (
            <div key={group.group} className="mb-4">
              <p className="px-1.5 pb-1 text-[10px] tracking-widest text-[#5a5a5a] uppercase">{group.group}</p>
              {group.items.map((item) => {
                const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`block rounded-[2px] px-1.5 py-1 text-[12px] ${
                      active ? 'bg-[#141414] text-white' : 'text-[#8a8a8a] hover:text-white'
                    }`}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="mt-auto border-t border-[#1f1f1f] px-3 py-2 md:fixed md:bottom-0 md:w-52">
          <div className="mb-1 truncate text-[11px] text-[#8a8a8a]">{session.data?.user.email}</div>
          <div className="flex items-center justify-between">
            <Link to="/system/update" className="font-mono text-[11px] text-[#5a5a5a] hover:text-white">
              {version.data?.current ?? 'dev'}
              {version.data?.update_available ? ' →' : ''}
            </Link>
            <button
              onClick={() => logout.mutate()}
              className="text-[11px] text-[#5a5a5a] hover:text-white"
            >
              sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-4 md:px-6 md:py-5">{children}</main>

      {paletteOpen ? <CommandPalette links={links} onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  )
}
