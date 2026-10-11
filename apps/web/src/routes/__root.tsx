import type { ReactNode } from 'react'
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRouteWithContext, HeadContent, Outlet, Scripts, useRouterState } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthGate } from '../components/auth-gate'
import { Shell } from '../components/shell'
// Side-effect import: Vite emits and injects the hashed stylesheet itself.
// Referencing it by ?url instead would bake the server build's hash into the
// prerendered shell, which does not match the client build's hash.
import '../styles.css'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
	head: () => ({
		meta: [
			{ charSet: 'utf-8' },
			{ name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
			{ name: 'color-scheme', content: 'dark' },
			{ name: 'theme-color', content: '#000' },
			// Pages replace this from their breadcrumb; it stands for login and setup.
			{ title: 'Vexdock' },
		],
	}),
	component: RootComponent,
})

/** Routes that render without the authenticated shell. */
const publicRoutes = new Set(['/login', '/setup'])

function RootComponent() {
	const pathname = useRouterState({ select: state => state.location.pathname })
	const isPublic = publicRoutes.has(pathname)
	const { queryClient } = Route.useRouteContext()

	return (
		<RootDocument>
			<MotionConfig reducedMotion='user'>
				<TooltipProvider>
					<QueryClientProvider client={queryClient}>
						<AuthGate>
							{isPublic ? (
								<Outlet />
							) : (
								<Shell>
									<Outlet />
								</Shell>
							)}
						</AuthGate>
					</QueryClientProvider>
				</TooltipProvider>
			</MotionConfig>
		</RootDocument>
	)
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
	return (
		<html lang='en' data-theme='dark'>
			<head>
				<HeadContent />
			</head>
			{/* The inline colors paint before the stylesheet arrives, so booting
          the SPA never flashes white. They are the dark --background and
          --foreground from styles.css, resolved to sRGB. */}
			<body style={{ background: '#000', color: '#f2f2f2' }}>
				<div id='root'>{children}</div>
				<Scripts />
			</body>
		</html>
	)
}
