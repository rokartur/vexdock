import { createRootRoute, HeadContent, Outlet, Scripts, useRouterState } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { AuthGate } from '../components/auth-gate'
import { Shell } from '../components/shell'
import styles from '../styles.css?url'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The panel is a live view of a server: short staleness, no aggressive
      // refetch storms.
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
})

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'color-scheme', content: 'dark' },
      { title: 'Platform' },
    ],
    links: [{ rel: 'stylesheet', href: styles }],
  }),
  component: RootComponent,
})

/** Routes that render without the authenticated shell. */
const publicRoutes = new Set(['/login', '/setup'])

function RootComponent() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const isPublic = publicRoutes.has(pathname)

  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <AuthGate>{isPublic ? <Outlet /> : <Shell>{<Outlet />}</Shell>}</AuthGate>
      </QueryClientProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div id="root">{children}</div>
        <Scripts />
      </body>
    </html>
  )
}
