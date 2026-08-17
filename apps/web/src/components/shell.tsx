import { Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconChevronDown, IconLayoutSidebar, IconSearch, IconSettings } from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'

import { api } from '../lib/api'
import { cn } from '@/lib/utils'
import { signOut, useSession } from '../lib/auth-client'
import { CommandPalette } from './command-palette'
import { NavigationSidebar } from './navigation-sidebar'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type NavItem = { to: string; label: string; exact?: boolean }

/** Shown above the labelled groups, the way the rail's most-used links are. */
const quickLinks: NavItem[] = [
  { to: '/', label: 'Dashboard', exact: true },
  { to: '/projects', label: 'Projects' },
  { to: '/domains', label: 'Domains' },
]

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: 'Docker',
    items: [
      { to: '/docker/containers', label: 'Containers' },
      { to: '/docker/images', label: 'Images' },
      { to: '/docker/volumes', label: 'Volumes' },
      { to: '/docker/networks', label: 'Networks' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/system', label: 'Overview', exact: true },
      { to: '/system/docker', label: 'Cleanup' },
      { to: '/system/backups', label: 'Backups' },
      { to: '/system/update', label: 'Update' },
      { to: '/system/settings', label: 'Settings' },
    ],
  },
]

const HIDDEN_KEY = 'navigation-leftBarIsHidden'
const useHydrationEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

const linkClass =
  'group flex h-7 items-center gap-2 rounded-lg px-2 text-[14px] font-medium text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200 data-[status=active]:bg-zinc-800 data-[status=active]:text-zinc-100 data-[status=active]:hover:bg-zinc-800'

function NavigationLink({ to, label, exact, dot }: NavItem & { dot?: boolean }) {
  return (
    <Link draggable={false} to={to} activeOptions={{ exact: exact ?? false }} className={linkClass}>
      <span className="truncate">{label}</span>
      {dot ? <span className="ml-auto size-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden /> : null}
    </Link>
  )
}

/** The rail plus the content panel it sits next to. Cmd/Ctrl+K opens the palette, `[` hides the rail. */
export function Shell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [isHidden, setIsHidden] = useState(false)
  const [showTemporary, setShowTemporary] = useState(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const version = useQuery({ queryKey: ['version'], queryFn: api.version, refetchInterval: 60_000 })
  const updateAvailable = version.data?.update_available ?? false
  const session = useSession()

  const logout = useMutation({
    mutationFn: () => signOut(),
    onSuccess: async () => {
      queryClient.clear()
      await navigate({ to: '/login', replace: true })
    },
  })

  useHydrationEffect(() => {
    setIsHidden(localStorage.getItem(HIDDEN_KEY) === 'true')
  }, [])

  const toggleHidden = () => {
    setIsHidden((hidden) => {
      localStorage.setItem(HIDDEN_KEY, String(!hidden))
      return !hidden
    })
    setShowTemporary(false)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      const target = event.target as HTMLElement | null
      const typing = target?.isContentEditable || /^(input|textarea|select)$/i.test(target?.tagName ?? '')
      if (event.key === '[' && !typing && !event.metaKey && !event.ctrlKey) toggleHidden()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const links = useMemo(() => [...quickLinks, ...groups.flatMap((group) => group.items)], [])
  const email = session.data?.user.email ?? ''

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <NavigationSidebar
        isHidden={isHidden}
        showTemporary={showTemporary}
        onShowTemporaryChange={setShowTemporary}
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <DropdownMenu>
              <DropdownMenuTrigger className="flex h-7 max-w-full min-w-0 items-center gap-2 rounded-lg pr-2 pl-1 text-left hover:bg-zinc-800/50">
                <Avatar className="size-5 rounded-md">
                  <AvatarFallback className="rounded-md bg-zinc-600 text-[9px] font-normal text-white">
                    PL
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-sm font-normal text-white">platform</span>
                <IconChevronDown className="size-3 shrink-0 text-zinc-400" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="start" sideOffset={8} className="w-64">
                <DropdownMenuItem render={<Link to="/system/settings" />}>Settings</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setPaletteOpen(true)}>
                  Jump to
                  <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {email ? <div className="text-muted-foreground truncate px-2 py-1.5 text-xs">{email}</div> : null}
                <DropdownMenuItem onClick={() => logout.mutate()}>Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex size-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              aria-label="Search"
            >
              <IconSearch className="size-4" />
            </button>
            <button
              type="button"
              onClick={toggleHidden}
              className="flex size-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              aria-label={isHidden ? 'Show sidebar' : 'Hide sidebar'}
            >
              <IconLayoutSidebar className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
          <div className="flex flex-col gap-0.5">
            {quickLinks.map((item) => (
              <NavigationLink key={item.to} {...item} />
            ))}
          </div>

          {groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-1">
              <span className="px-2 text-[12px] font-medium tracking-wide text-zinc-500 uppercase">
                {group.label}
              </span>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <NavigationLink key={item.to} {...item} dot={updateAvailable && item.to === '/system/update'} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-0.5 border-t border-zinc-800/60 pt-2">
          <Link
            draggable={false}
            to="/system/settings"
            className="group flex h-8 items-center gap-2 rounded-lg px-2 text-left hover:bg-zinc-800/50"
          >
            <Avatar className="size-5">
              <AvatarFallback className="bg-zinc-600 text-[9px] font-normal text-white">
                {(email || '?').slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-zinc-400 group-hover:text-zinc-200">
              {email || 'Account'}
            </span>
            <IconSettings className="size-3.5 shrink-0 text-zinc-600 group-hover:text-zinc-400" />
          </Link>
          <Link
            to="/system/update"
            className={cn(
              'px-2 font-mono text-[12px]',
              updateAvailable ? 'text-emerald-400 hover:text-emerald-300' : 'text-zinc-600 hover:text-zinc-400',
            )}
          >
            {version.data?.current ?? 'dev'}
            {updateAvailable ? ` → ${version.data?.latest}` : ''}
          </Link>
        </div>
      </NavigationSidebar>

      <main className="bg-background m-2 ml-0 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-900">
        {children}
      </main>

      <CommandPalette links={links} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  )
}
