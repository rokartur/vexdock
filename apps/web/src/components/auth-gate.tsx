import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'

import { fetchSetupStatus, useSession } from '../lib/auth-client'

/**
 * Routes the visitor to setup, login or the app. Every authenticated page can
 * therefore assume a session exists.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  const setup = useQuery({ queryKey: ['auth', 'setup'], queryFn: fetchSetupStatus, retry: false })
  const session = useSession()

  const needsSetup = setup.data?.needs_setup === true
  const authenticated = Boolean(session.data?.user)
  const resolved = setup.data !== undefined && !session.isPending

  useEffect(() => {
    if (!resolved) return
    if (needsSetup && pathname !== '/setup') {
      void navigate({ to: '/setup', replace: true })
      return
    }
    if (!needsSetup && !authenticated && pathname !== '/login') {
      void navigate({ to: '/login', replace: true })
      return
    }
    if (authenticated && (pathname === '/login' || pathname === '/setup')) {
      void navigate({ to: '/', replace: true })
    }
  }, [resolved, needsSetup, authenticated, pathname, navigate])

  if (!resolved) {
    return <div className="text-muted-foreground p-6 text-xs">Connecting to the manager…</div>
  }
  if (setup.isError) {
    return (
      <div className="text-destructive p-6 text-xs">
        The manager is unreachable. It may be restarting after an update.
      </div>
    )
  }

  // Hold the route back while the redirect above is in flight. Rendering the
  // authenticated shell first would mount every dashboard query and fire a
  // burst of requests that can only answer 401.
  const target = needsSetup ? '/setup' : authenticated ? null : '/login'
  if (target && target !== pathname) return null

  return <>{children}</>
}
