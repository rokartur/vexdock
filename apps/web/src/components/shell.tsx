import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { api } from '../lib/api'
import { CommandPalette } from './command-palette'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'

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

/** Sidebar plus content, with the command palette bound to Cmd/Ctrl+K. */
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
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const links = useMemo(() => navigation.flatMap((group) => group.items), [])

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex h-8 items-center justify-between gap-2 px-1">
            <Link to="/" className="text-[13px] font-medium tracking-tight">
              platform
            </Link>
            <button
              onClick={() => setPaletteOpen(true)}
              title="Command palette"
              className="hover:text-foreground text-muted-foreground"
            >
              <Kbd>⌘K</Kbd>
            </button>
          </div>
        </SidebarHeader>

        <SidebarContent>
          {navigation.map((group) => (
            <SidebarGroup key={group.group}>
              <SidebarGroupLabel>{group.group}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const active =
                      item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
                    return (
                      <SidebarMenuItem key={item.to}>
                        <SidebarMenuButton asChild isActive={active} size="sm" tooltip={item.label}>
                          <Link to={item.to}>{item.label}</Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>

        <SidebarFooter>
          <div className="text-muted-foreground truncate px-1 text-[11px]">{session.data?.user.email}</div>
          <div className="flex items-center justify-between px-1">
            <Link to="/system/update" className="hover:text-foreground text-muted-foreground font-mono text-[11px]">
              {version.data?.current ?? 'dev'}
              {version.data?.update_available ? ' →' : ''}
            </Link>
            <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => logout.mutate()}>
              sign out
            </Button>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3 md:hidden">
          <SidebarTrigger />
        </header>
        <main className="min-w-0 flex-1 px-4 py-4 md:px-6 md:py-5">{children}</main>
      </SidebarInset>

      <CommandPalette links={links} open={paletteOpen} onOpenChange={setPaletteOpen} />
    </SidebarProvider>
  )
}
