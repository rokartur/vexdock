import { createRootRoute, HeadContent, Outlet, Scripts, useRouterState } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { AuthGate } from '../components/auth-gate'
import { Shell } from '../components/shell'
import { Toaster } from '@/components/ui/toast'
import { TooltipProvider } from '@/components/ui/tooltip'
// Side-effect import: Vite emits and injects the hashed stylesheet itself.
// Referencing it by ?url instead would bake the server build's hash into the
// prerendered shell, which does not match the client build's hash.
import '../styles.css'

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
        <TooltipProvider delay={300}>
          <AuthGate>
            {isPublic ? (
              <Outlet />
            ) : (
              <Shell>
                <Outlet />
              </Shell>
            )}
          </AuthGate>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // The panel is dark only; there is no theme switch to keep in sync.
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      {/* The inline colours paint before the stylesheet arrives, so booting
          the SPA never flashes white. They match --sidebar, the page surface. */}
      <body style={{ background: '#080809', color: '#f3f3f4' }}>
        <div id="root">{children}</div>
        <Scripts />
      </body>
    </html>
  )
}
