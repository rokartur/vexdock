import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'

import { api, setCsrfToken } from '../lib/api'

/**
 * Resolves the session once and routes the user to setup, login or the app.
 * Every authenticated page can therefore assume a session exists.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  const status = useQuery({
    queryKey: ['auth', 'status'],
    queryFn: api.authStatus,
    staleTime: 0,
    retry: false,
  })

  const session = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: api.me,
    enabled: status.data?.authenticated === true,
    retry: false,
  })

  useEffect(() => {
    if (session.data?.csrf_token) setCsrfToken(session.data.csrf_token)
  }, [session.data?.csrf_token])

  useEffect(() => {
    if (!status.data) return
    if (status.data.needs_setup && pathname !== '/setup') {
      void navigate({ to: '/setup', replace: true })
      return
    }
    if (!status.data.needs_setup && !status.data.authenticated && pathname !== '/login') {
      void navigate({ to: '/login', replace: true })
      return
    }
    if (status.data.authenticated && (pathname === '/login' || pathname === '/setup')) {
      void navigate({ to: '/', replace: true })
    }
  }, [status.data, pathname, navigate])

  if (status.isLoading) {
    return <div className="p-6 text-[12px] text-[#8a8a8a]">Connecting to the manager…</div>
  }
  if (status.isError) {
    return (
      <div className="p-6 text-[12px] text-[#ff5f56]">
        The manager is unreachable. It may be restarting after an update.
      </div>
    )
  }
  // Hold the route back while the redirect above is in flight. Rendering the
  // authenticated shell first would mount every dashboard query and fire a
  // burst of requests that can only answer 401.
  const target = requiredRoute(status.data)
  if (target && target !== pathname) return null

  return <>{children}</>
}

/** The only route an unauthenticated or unconfigured visitor may see. */
function requiredRoute(status: { needs_setup: boolean; authenticated: boolean } | undefined) {
  if (!status) return null
  if (status.needs_setup) return '/setup'
  if (!status.authenticated) return '/login'
  return null
}
